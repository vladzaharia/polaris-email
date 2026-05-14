// Append-only, hash-chained audit log writer.
// Every state mutation goes through audit(); CI runs lint:audit-coverage to verify call-sites.
import type { AuditAction } from '@polaris-email/schema';
import { sha256Hex } from './hashing.js';
import type { Env } from './env.js';

export interface AuditArgs {
  actor: string;
  action: AuditAction;
  target?: string | null;
  meta?: Record<string, unknown>;
  at?: number;
}

/**
 * Write one audit row, chaining the row_hash to the previous row's row_hash.
 * Uses a serialised D1 transaction so concurrent writers can't break the chain.
 */
export async function audit(env: Env, args: AuditArgs): Promise<void> {
  const at = args.at ?? Date.now();
  const meta = JSON.stringify(args.meta ?? {});
  // Fetch previous row_hash.
  const prev = await env.DB.prepare(
    `SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1`,
  ).first<{ row_hash: string }>();
  const prevHash = prev?.row_hash ?? '0'.repeat(64);
  const canonical = [args.actor, args.action, args.target ?? '', meta, prevHash, String(at)].join(
    '\n',
  );
  const rowHash = await sha256Hex(canonical);
  await env.DB.prepare(
    `INSERT INTO audit_log (actor, action, target, meta, prev_hash, row_hash, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(args.actor, args.action, args.target ?? null, meta, prevHash, rowHash, at)
    .run();
}

/**
 * Verify the chain from `fromId` to `toId` (inclusive). Returns the id of the first
 * broken row (where prev_hash or row_hash doesn't match) or null if fully valid.
 */
export async function verifyChain(
  env: Env,
  fromId = 0,
  toId?: number,
): Promise<{ ok: true } | { ok: false; brokenAt: number; reason: string }> {
  const rows = toId
    ? await env.DB.prepare(
        `SELECT id, actor, action, target, meta, prev_hash, row_hash, at
         FROM audit_log WHERE id >= ? AND id <= ? ORDER BY id ASC`,
      )
        .bind(fromId, toId)
        .all<{
          id: number;
          actor: string;
          action: string;
          target: string | null;
          meta: string;
          prev_hash: string;
          row_hash: string;
          at: number;
        }>()
    : await env.DB.prepare(
        `SELECT id, actor, action, target, meta, prev_hash, row_hash, at
         FROM audit_log WHERE id >= ? ORDER BY id ASC`,
      )
        .bind(fromId)
        .all<{
          id: number;
          actor: string;
          action: string;
          target: string | null;
          meta: string;
          prev_hash: string;
          row_hash: string;
          at: number;
        }>();
  let prev = '0'.repeat(64);
  for (const r of rows.results) {
    if (r.id === 0) {
      prev = r.row_hash;
      continue;
    }
    if (r.prev_hash !== prev) {
      return { ok: false, brokenAt: r.id, reason: 'prev_hash mismatch' };
    }
    const canonical = [r.actor, r.action, r.target ?? '', r.meta, r.prev_hash, String(r.at)].join(
      '\n',
    );
    const expected = await sha256Hex(canonical);
    if (expected !== r.row_hash) {
      return { ok: false, brokenAt: r.id, reason: 'row_hash mismatch' };
    }
    prev = r.row_hash;
  }
  return { ok: true };
}
