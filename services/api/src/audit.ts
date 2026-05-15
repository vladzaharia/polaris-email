// Append-only, hash-chained audit log writer.
// Every state mutation goes through audit(); CI runs lint:audit-coverage to verify call-sites.
//
// Concurrency model (Phase A7 hardening):
//   The chain is `row_hash = sha256(actor || action || target || meta || prev_hash || at)`
//   so every new row must read the previous tip and chain off it. A naive
//   read-then-write lets two concurrent writers observe the same tip and
//   produce a forked chain (`verifyChain` would later find a `prev_hash`
//   mismatch and refuse to validate).
//
//   We avoid the fork with a SQLite compare-and-swap (CAS): the INSERT only
//   succeeds if `MAX(id)` is still what we read. If a concurrent writer beat
//   us, `meta.changes === 0` and we retry with the new tip. The retry loop
//   is bounded; under realistic contention it terminates in 1–2 iterations.
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

const MAX_AUDIT_RETRIES = 8;

/**
 * Write one audit row, chaining the row_hash to the previous row's row_hash.
 *
 * Uses an INSERT ... SELECT ... WHERE compare-and-swap on `MAX(id)` so that
 * concurrent writers can't both succeed against the same tip. If the CAS
 * fails (`changes === 0`) we re-read and retry up to `MAX_AUDIT_RETRIES`
 * times. Under SQLite/D1's serialised writer this loop converges quickly;
 * an exhausted retry budget throws so callers can surface the failure.
 */
export async function audit(env: Env, args: AuditArgs): Promise<void> {
  const at = args.at ?? Date.now();
  const meta = JSON.stringify(args.meta ?? {});

  for (let attempt = 0; attempt < MAX_AUDIT_RETRIES; attempt++) {
    // Read the current tip (id + row_hash). Returning -1 for the empty-table
    // case keeps the CAS comparison aligned with the SELECT MAX(...) below.
    const tip = await env.DB.prepare(
      `SELECT id, row_hash FROM audit_log ORDER BY id DESC LIMIT 1`,
    ).first<{ id: number; row_hash: string }>();
    const prevId: number = tip?.id ?? -1;
    const prevHash: string = tip?.row_hash ?? '0'.repeat(64);

    const canonical = [args.actor, args.action, args.target ?? '', meta, prevHash, String(at)].join(
      '\n',
    );
    const rowHash = await sha256Hex(canonical);

    // CAS insert: only succeeds if the tip we observed is still the latest.
    // If another writer appended between our SELECT and our INSERT, the
    // subquery yields a different id and the INSERT writes zero rows; we
    // detect that via meta.changes and loop.
    const res = await env.DB.prepare(
      `INSERT INTO audit_log (actor, action, target, meta, prev_hash, row_hash, at)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE (SELECT IFNULL(MAX(id), -1) FROM audit_log) = ?`,
    )
      .bind(args.actor, args.action, args.target ?? null, meta, prevHash, rowHash, at, prevId)
      .run();
    if (res.meta && res.meta.changes && res.meta.changes > 0) return;
    // changes === 0 → contention. Loop and re-read the tip.
  }
  throw new Error('audit: CAS exhausted after retries');
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
