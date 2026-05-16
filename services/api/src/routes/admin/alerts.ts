// W2d — Read-only admin surface over admin_alerts + a "test alert" trigger.
//
// Mutations: only the test endpoint is exposed (and it's approval-gated at
// the panel proxy layer). The historical ledger is immutable.
import { Hono } from 'hono';
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
}

const COLS =
  'id, alert_type, severity, target, subject, body, delivery, payload, dedupe_key, created_at';

alerts.get('/v1/admin/alerts', requireScope('admin:read'), async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? '100'), 1), 500);
  const alertType = c.req.query('alert_type');
  const severity = c.req.query('severity');
  const target = c.req.query('target');
  const since = c.req.query('since');

  const where: string[] = [];
  const binds: unknown[] = [];
  if (alertType) {
    where.push('alert_type = ?');
    binds.push(alertType);
  }
  if (severity) {
    where.push('severity = ?');
    binds.push(severity);
  }
  if (target) {
    where.push('target = ?');
    binds.push(target);
  }
  if (since) {
    where.push('created_at >= ?');
    binds.push(since);
  }

  const sql =
    `SELECT ${COLS} FROM admin_alerts` +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY created_at DESC LIMIT ?';
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
