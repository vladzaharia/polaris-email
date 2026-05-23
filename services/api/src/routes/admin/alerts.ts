// W2d — Read-only admin surface over admin_alerts + a "test alert" trigger.
//
// Mutations: only the test endpoint and the soft-dismissal endpoints are
// exposed (dismissals are also approval-gated at the panel proxy layer).
// Rows are never physically deleted — dismissal sets `dismissed_at` /
// `dismissed_by` so the historical ledger stays intact and operators can
// re-expose dismissed rows via `?include_dismissed=1`.
import { Hono } from 'hono';
import { actorOf, audit } from '../../audit.js';
import { requireScope } from '../../auth.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';
import { sendAlert } from '../../lib/admin-alert.js';

export const alerts = new Hono<{ Bindings: Env }>();

interface AdminAlertRow {
  id: string;
  alert_type: string;
  severity: string;
  target: string;
  subject: string;
  body: string;
  delivery: string;
  payload: string;
  dedupe_key: string;
  created_at: string;
  dismissed_at: string | null;
  dismissed_by: string | null;
}

const COLS =
  'id, alert_type, severity, target, subject, body, delivery, payload, dedupe_key, created_at, dismissed_at, dismissed_by';

interface FilterInput {
  alertType: string | null;
  severity: string | null;
  target: string | null;
  since: string | null;
}

// Build the shared WHERE clause used by both list (GET) and bulk-dismiss
// (POST /dismiss). Centralising prevents the two endpoints from drifting on
// what "the current filter" means.
function buildFilterWhere(
  filter: FilterInput,
  options: { activeOnly: boolean },
): { sql: string; binds: unknown[] } {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (filter.alertType) {
    where.push('alert_type = ?');
    binds.push(filter.alertType);
  }
  if (filter.severity) {
    where.push('severity = ?');
    binds.push(filter.severity);
  }
  if (filter.target) {
    where.push('target = ?');
    binds.push(filter.target);
  }
  if (filter.since) {
    where.push('created_at >= ?');
    binds.push(filter.since);
  }
  if (options.activeOnly) {
    where.push('dismissed_at IS NULL');
  }
  return {
    sql: where.length ? ' WHERE ' + where.join(' AND ') : '',
    binds,
  };
}

alerts.get('/v1/admin/alerts', requireScope('admin:read'), async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? '100'), 1), 500);
  const includeDismissed = c.req.query('include_dismissed') === '1';
  const filter: FilterInput = {
    alertType: c.req.query('alert_type') ?? null,
    severity: c.req.query('severity') ?? null,
    target: c.req.query('target') ?? null,
    since: c.req.query('since') ?? null,
  };
  const { sql: whereSql, binds } = buildFilterWhere(filter, { activeOnly: !includeDismissed });
  const sql = `SELECT ${COLS} FROM admin_alerts${whereSql} ORDER BY created_at DESC LIMIT ?`;
  binds.push(limit);
  const rows = await c.env.DB.prepare(sql)
    .bind(...binds)
    .all<AdminAlertRow>();
  return c.json({ data: rows.results ?? [] });
});

alerts.get('/v1/admin/alerts/:id', requireScope('admin:read'), async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(`SELECT ${COLS} FROM admin_alerts WHERE id = ?`)
    .bind(id)
    .first<AdminAlertRow>();
  if (!row) return buildError(c, 'not_found', 'alert not found');
  return c.json(row);
});

// Single-row dismiss. Idempotent: re-dismissing an already-dismissed row
// returns 200 with the original dismissed_at / dismissed_by intact (no
// audit row is written on the no-op so we don't spam the chain).
alerts.post('/v1/admin/alerts/:id/dismiss', requireScope('admin:rotate'), async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare(
    `SELECT id, dismissed_at, dismissed_by FROM admin_alerts WHERE id = ?`,
  )
    .bind(id)
    .first<{ id: string; dismissed_at: string | null; dismissed_by: string | null }>();
  if (!existing) return buildError(c, 'not_found', 'alert not found');
  if (existing.dismissed_at) {
    return c.json({
      id,
      dismissed_at: existing.dismissed_at,
      dismissed_by: existing.dismissed_by,
      already_dismissed: true,
    });
  }
  const actor = actorOf(c);
  const nowIso = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE admin_alerts SET dismissed_at = ?, dismissed_by = ?
       WHERE id = ? AND dismissed_at IS NULL`,
  )
    .bind(nowIso, actor, id)
    .run();
  await audit(c.env, {
    actor,
    action: 'admin.alert.dismiss',
    target: id,
    meta: {},
  });
  return c.json({ id, dismissed_at: nowIso, dismissed_by: actor, already_dismissed: false });
});

// Bulk dismiss by filter — mirrors the list endpoint's filter shape so the
// panel can say "Dismiss N filtered alerts" and the server applies the
// same WHERE clause. Only active (not-yet-dismissed) rows are touched so
// repeating the call is a no-op. A single audit row records the dismissal
// event with the resulting count + filter snapshot.
interface BulkDismissBody {
  alert_type?: string;
  severity?: string;
  target?: string;
  since?: string;
}

alerts.post('/v1/admin/alerts/dismiss', requireScope('admin:rotate'), async (c) => {
  let body: BulkDismissBody = {};
  try {
    const text = await c.req.text();
    body = text ? (JSON.parse(text) as BulkDismissBody) : {};
  } catch (e) {
    return buildError(c, 'bad_request', e instanceof Error ? e.message : 'invalid body');
  }
  const filter: FilterInput = {
    alertType: body.alert_type ?? null,
    severity: body.severity ?? null,
    target: body.target ?? null,
    since: body.since ?? null,
  };
  const { sql: whereSql, binds } = buildFilterWhere(filter, { activeOnly: true });
  const actor = actorOf(c);
  const nowIso = new Date().toISOString();
  const updateBinds: unknown[] = [nowIso, actor, ...binds];
  const r = await c.env.DB.prepare(
    `UPDATE admin_alerts SET dismissed_at = ?, dismissed_by = ?${whereSql}`,
  )
    .bind(...updateBinds)
    .run();
  const dismissed = r.meta.changes ?? 0;
  if (dismissed > 0) {
    await audit(c.env, {
      actor,
      action: 'admin.alert.dismiss_bulk',
      target: 'admin_alerts',
      meta: { dismissed, filter: body },
    });
  }
  return c.json({ dismissed, filter: body });
});

// Trigger a synthetic alert end-to-end. Used by the panel "Test alert"
// button so operators can verify the pipeline (webhook reachable, dedupe
// behaving, ALERT_WEBHOOK configured) without waiting for a real event.
// Approval-gated at the panel proxy.
alerts.post('/v1/admin/alerts/test', requireScope('admin:rotate'), async (c) => {
  const r = await sendAlert(c.env, {
    alert_type: 'manual',
    severity: 'info',
    target: 'synthetic-test',
    subject: '[POLARIS][TEST] synthetic admin-alert pipeline check',
    body: 'This is a synthetic alert fired from the panel "Test alert" button.',
    payload: {
      source: 'panel.test-alert',
      timestamp: Date.now(),
    },
  });
  return c.json(r);
});
