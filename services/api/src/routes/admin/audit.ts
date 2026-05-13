// Admin audit routes: chain-status (head + last anchor), paginated chain
// listing, and the anchor list.
import { Hono } from 'hono';
import { requireScope } from '../../auth.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';

export const auditRoutes = new Hono<{ Bindings: Env }>();

auditRoutes.get('/v1/admin/audit/chain-status', requireScope('admin:read'), async (c) => {
  const head = await c.env.DB.prepare(
    `SELECT id, row_hash, at FROM audit_log ORDER BY id DESC LIMIT 1`,
  ).first<{ id: number; row_hash: string; at: number }>();
  const anchor = await c.env.DB.prepare(
    `SELECT id, last_audit_id, last_row_hash, signature, signed_at, external_ref
     FROM audit_anchors ORDER BY id DESC LIMIT 1`,
  ).first<{
    id: number;
    last_audit_id: number;
    last_row_hash: string;
    signature: string;
    signed_at: number;
    external_ref: string | null;
  }>();
  return c.json({ head, latest_anchor: anchor });
});

auditRoutes.get('/v1/admin/audit/chain', requireScope('admin:read'), async (c) => {
  const limit = Math.min(Math.max(Number.parseInt(c.req.query('limit') ?? '50', 10) || 50, 1), 500);
  const beforeId = Number.parseInt(c.req.query('before_id') ?? '0', 10);
  let rows;
  if (beforeId > 0) {
    rows = await c.env.DB.prepare(
      `SELECT id, actor, action, target, at, prev_hash, row_hash
       FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?`,
    )
      .bind(beforeId, limit)
      .all();
  } else {
    rows = await c.env.DB.prepare(
      `SELECT id, actor, action, target, at, prev_hash, row_hash
       FROM audit_log ORDER BY id DESC LIMIT ?`,
    )
      .bind(limit)
      .all();
  }
  return c.json({ data: rows.results });
});

auditRoutes.get('/v1/admin/audit/anchors', requireScope('admin:read'), async (c) => {
  const limit = Math.min(Math.max(Number.parseInt(c.req.query('limit') ?? '50', 10) || 50, 1), 500);
  const rows = await c.env.DB.prepare(
    `SELECT id, last_audit_id, last_row_hash, signature, signed_at, external_ref
     FROM audit_anchors ORDER BY id DESC LIMIT ?`,
  )
    .bind(limit)
    .all();
  return c.json({ data: rows.results });
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _unused = buildError;
