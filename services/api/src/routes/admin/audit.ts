// Admin audit routes: chain head + paginated chain listing. The audit_log
// table keeps its in-row chained-hash invariant (each row's row_hash is
// SHA-256 of `prev_hash || canonical(this row)`); the auditVerify cron
// walks the chain end-to-end nightly to catch any out-of-band rewrite.
import { Hono } from 'hono';
import { requireScope } from '../../auth.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';

export const auditRoutes = new Hono<{ Bindings: Env }>();

auditRoutes.get('/v1/admin/audit/chain-status', requireScope('admin:read'), async (c) => {
  const head = await c.env.DB.prepare(
    `SELECT id, row_hash, at FROM audit_log ORDER BY id DESC LIMIT 1`,
  ).first<{ id: number; row_hash: string; at: number }>();
  return c.json({ head });
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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _unused = buildError;
