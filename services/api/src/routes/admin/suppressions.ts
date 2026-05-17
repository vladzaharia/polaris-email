// W1 — Admin suppression CRUD.
//
// Two-direction enforcement: rows with `entity_type='recipient'` block
// sending TO an address; rows with `entity_type='sender'` block sending FROM
// a principal/mailbox/sender_address. Both are filterable by reason, source,
// severity, and scope so the panel can render them in distinct tabs.
//
// Manual mutations are approval-gated at the panel layer (DestructiveActionDialog
// + the 428 dual-admin flow) — this route only enforces scope. The `disable`
// path is soft (sets `disabled_at`); rows are never deleted because the audit
// chain expects suppression history to be permanent.
import { Hono } from 'hono';
import {
  CreateSuppressionRequest,
  UpdateSuppressionRequest,
  type SuppressionRow,
} from '@polaris-email/schema';
import { normalizeAddress } from '@polaris-email/suppressions';
import { ulid } from '@polaris-email/ids';
import { actorOf, audit } from '../../audit.js';
import { bodyText, requireScope } from '../../auth.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';

export const suppressions = new Hono<{ Bindings: Env }>();

const COLS =
  'id, entity_type, address_normalized, address_local, address_domain, ' +
  'scope, scope_target, reason, source, source_ref, severity, ' +
  'created_at, expires_at, disabled_at, disabled_reason, notes';

interface ListFilters {
  entity_type: string | null;
  reason: string | null;
  source: string | null;
  severity: string | null;
  scope: string | null;
  scope_target: string | null;
  address: string | null;
  include_disabled: boolean;
  limit: number;
  cursor: string | null;
}

function readFilters(c: { req: { query: (k: string) => string | undefined } }): ListFilters {
  const limitRaw = Number(c.req.query('limit') ?? '100');
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 100;
  return {
    entity_type: c.req.query('entity_type') ?? null,
    reason: c.req.query('reason') ?? null,
    source: c.req.query('source') ?? null,
    severity: c.req.query('severity') ?? null,
    scope: c.req.query('scope') ?? null,
    scope_target: c.req.query('scope_target') ?? null,
    address: c.req.query('address') ?? null,
    include_disabled: (c.req.query('include_disabled') ?? '0') === '1',
    limit,
    cursor: c.req.query('cursor') ?? null,
  };
}

suppressions.get('/v1/admin/suppressions', requireScope('admin:read'), async (c) => {
  const f = readFilters(c);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (f.entity_type) {
    where.push('entity_type = ?');
    binds.push(f.entity_type);
  }
  if (f.reason) {
    where.push('reason = ?');
    binds.push(f.reason);
  }
  if (f.source) {
    where.push('source = ?');
    binds.push(f.source);
  }
  if (f.severity) {
    where.push('severity = ?');
    binds.push(f.severity);
  }
  if (f.scope) {
    where.push('scope = ?');
    binds.push(f.scope);
  }
  if (f.scope_target) {
    where.push('scope_target = ?');
    binds.push(f.scope_target);
  }
  if (f.address) {
    const n = normalizeAddress(f.address);
    where.push('address_normalized = ?');
    binds.push(n?.normalized ?? f.address.toLowerCase());
  }
  if (!f.include_disabled) where.push('disabled_at IS NULL');
  if (f.cursor) {
    where.push('created_at < ?');
    binds.push(f.cursor);
  }
  const sql =
    `SELECT ${COLS} FROM suppressions` +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY created_at DESC LIMIT ?';
  binds.push(f.limit);
  const rows = await c.env.DB.prepare(sql)
    .bind(...binds)
    .all<SuppressionRow>();
  const data = rows.results ?? [];
  const next_cursor = data.length === f.limit ? (data[data.length - 1]?.created_at ?? null) : null;
  return c.json({ data, next_cursor });
});

// Lookup-by-address — used by the CLI `polaris-email suppression check` and
// by the panel's "is this address suppressed?" inline check. Returns *all*
// active rows that match (could be both recipient and sender entries).
// Registered BEFORE the `/:id` route so Hono doesn't match `check` as an id.
suppressions.get('/v1/admin/suppressions/check', requireScope('admin:read'), async (c) => {
  const addr = c.req.query('address');
  if (!addr) return buildError(c, 'bad_request', 'address query param required');
  const n = normalizeAddress(addr);
  if (!n) return buildError(c, 'bad_request', 'invalid address');
  const rows = await c.env.DB.prepare(
    `SELECT ${COLS} FROM suppressions
       WHERE address_normalized = ? AND disabled_at IS NULL
       ORDER BY entity_type, created_at DESC`,
  )
    .bind(n.normalized)
    .all<SuppressionRow>();
  return c.json({ address: n.normalized, data: rows.results ?? [] });
});

suppressions.get('/v1/admin/suppressions/:id', requireScope('admin:read'), async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(`SELECT ${COLS} FROM suppressions WHERE id = ?`)
    .bind(id)
    .first<SuppressionRow>();
  if (!row) return buildError(c, 'not_found', 'suppression not found');
  return c.json(row);
});

suppressions.post('/v1/admin/suppressions', requireScope('admin:rotate'), async (c) => {
  let body;
  try {
    body = CreateSuppressionRequest.parse(JSON.parse(bodyText(c) || '{}'));
  } catch (e) {
    return buildError(c, 'bad_request', e instanceof Error ? e.message : 'invalid body');
  }
  const n = normalizeAddress(body.address);
  if (!n) return buildError(c, 'bad_request', 'invalid address');
  // Manual writes default source='panel' if the caller didn't override; CLI
  // callers can opt into source='cli'.
  const id = ulid();
  const nowIso = new Date().toISOString();
  try {
    await c.env.DB.prepare(
      `INSERT INTO suppressions
         (id, entity_type, address_normalized, address_local, address_domain,
          scope, scope_target, reason, source, source_ref, severity,
          created_at, expires_at, disabled_at, disabled_reason, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, ?)`,
    )
      .bind(
        id,
        body.entity_type,
        n.normalized,
        n.local,
        n.domain,
        body.scope,
        body.scope_target ?? null,
        body.reason,
        body.source,
        body.severity,
        nowIso,
        body.expires_at ?? null,
        body.notes ?? null,
      )
      .run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) {
      return buildError(c, 'conflict', 'an active suppression already exists for this tuple');
    }
    throw e;
  }
  await audit(c.env, {
    actor: actorOf(c),
    action: 'suppression.create',
    target: id,
    meta: {
      entity_type: body.entity_type,
      address: n.normalized,
      scope: body.scope,
      scope_target: body.scope_target ?? null,
      reason: body.reason,
      source: body.source,
      severity: body.severity,
    },
  });
  return c.json({ id, created_at: nowIso }, 201);
});

suppressions.patch('/v1/admin/suppressions/:id', requireScope('admin:rotate'), async (c) => {
  const id = c.req.param('id');
  let body;
  try {
    body = UpdateSuppressionRequest.parse(JSON.parse(bodyText(c) || '{}'));
  } catch (e) {
    return buildError(c, 'bad_request', e instanceof Error ? e.message : 'invalid body');
  }
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.notes !== undefined) {
    sets.push('notes = ?');
    binds.push(body.notes);
  }
  if (body.expires_at !== undefined) {
    sets.push('expires_at = ?');
    binds.push(body.expires_at);
  }
  if (!sets.length) return buildError(c, 'bad_request', 'no fields to update');
  binds.push(id);
  const r = await c.env.DB.prepare(`UPDATE suppressions SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds)
    .run();
  if (r.meta.changes === 0) return buildError(c, 'not_found', 'suppression not found');
  await audit(c.env, {
    actor: actorOf(c),
    action: 'suppression.create', // patch reuses .create since there's no .update enum
    target: id,
    meta: { patch: Object.keys(body) },
  });
  return c.json({ id, updated_at: Date.now() });
});

// Soft-disable. Rows are never deleted (audit-chain invariant). The
// `disabled_reason` field is required so the operator's intent is captured.
suppressions.delete('/v1/admin/suppressions/:id', requireScope('admin:rotate'), async (c) => {
  const id = c.req.param('id');
  const reason = c.req.query('reason') ?? 'operator_override';
  const nowIso = new Date().toISOString();
  const r = await c.env.DB.prepare(
    `UPDATE suppressions SET disabled_at = ?, disabled_reason = ?
       WHERE id = ? AND disabled_at IS NULL`,
  )
    .bind(nowIso, reason, id)
    .run();
  if (r.meta.changes === 0) {
    return buildError(c, 'not_found', 'not found or already disabled');
  }
  await audit(c.env, {
    actor: actorOf(c),
    action: 'suppression.disable',
    target: id,
    meta: { reason },
  });
  return c.json({ id, disabled_at: nowIso });
});
