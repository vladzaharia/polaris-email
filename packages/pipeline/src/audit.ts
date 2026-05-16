// Append-only, hash-chained audit log writer.
//
// Concurrency model:
//   The chain is `row_hash = sha256(actor || action || target || meta || prev_hash || at)`,
//   so every new row must read the previous tip and chain off it. A naive
//   read-then-write lets two concurrent writers observe the same tip and
//   produce a forked chain (`verifyChain` would later find a `prev_hash`
//   mismatch and refuse to validate).
//
//   We avoid the fork with a SQLite compare-and-swap (CAS): the INSERT only
//   succeeds if `MAX(id)` is still what we read. If a concurrent writer beat
//   us, `meta.changes === 0` and we retry with the new tip. The retry loop
//   is bounded; under realistic contention it terminates in 1–2 iterations.
//
// This module is the single canonical writer for the `audit_log` table.
// services/api re-exports `audit` from here; services/in/out and the
// pipeline both depend on it directly via `@polaris-email/pipeline`. Having
// one writer is a P0 correctness requirement: two private implementations
// (one CAS, one naive) racing on the same table will fork the chain and
// brick `verifyChain` for everything written after the fork.

export interface AuditWriterEnv {
  DB: D1Database;
}

export interface AuditArgs {
  actor: string;
  // Kept as `string` (not the Zod-narrowed `AuditAction`) so this package
  // doesn't take a hard dependency on `@polaris-email/schema`. The DB CHECK
  // constraint enforces the action enum at write time.
  action: string;
  target?: string | null;
  meta?: Record<string, unknown>;
  at?: number;
}

const MAX_AUDIT_RETRIES = 8;

async function sha256Hex(data: string): Promise<string> {
  const bytes = new TextEncoder().encode(data);
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const out = new Uint8Array(digest);
  let s = '';
  for (const b of out) s += b.toString(16).padStart(2, '0');
  return s;
}

/**
 * Build the canonical INSERT statement + bind values for one audit row,
 * given the observed tip. Exposed so a caller can fold the audit write into
 * the same `db.batch([...])` as the primary mutation, preventing
 * Worker-eviction loss between the two writes.
 *
 * The returned statement uses the same CAS form as `audit()`: zero rows
 * written means the tip moved between observation and execution. Callers
 * folding into a batch should typically prefer `audit()` (with its retry
 * loop) unless they specifically need the all-or-nothing batch semantics.
 */
export async function buildAuditInsert(
  env: AuditWriterEnv,
  args: AuditArgs,
): Promise<{ statement: D1PreparedStatement; prevId: number; rowHash: string }> {
  const at = args.at ?? Date.now();
  const meta = JSON.stringify(args.meta ?? {});
  const tip = await env.DB.prepare(
    `SELECT id, row_hash FROM audit_log ORDER BY id DESC LIMIT 1`,
  ).first<{ id: number; row_hash: string }>();
  const prevId: number = tip?.id ?? -1;
  const prevHash: string = tip?.row_hash ?? '0'.repeat(64);
  const canonical = [args.actor, args.action, args.target ?? '', meta, prevHash, String(at)].join(
    '\n',
  );
  const rowHash = await sha256Hex(canonical);
  const statement = env.DB.prepare(
    `INSERT INTO audit_log (actor, action, target, meta, prev_hash, row_hash, at)
     SELECT ?, ?, ?, ?, ?, ?, ?
     WHERE (SELECT IFNULL(MAX(id), -1) FROM audit_log) = ?`,
  ).bind(args.actor, args.action, args.target ?? null, meta, prevHash, rowHash, at, prevId);
  return { statement, prevId, rowHash };
}

/**
 * Write one audit row, chaining the row_hash to the previous row's row_hash.
 *
 * Uses an INSERT ... SELECT ... WHERE compare-and-swap on `MAX(id)` so that
 * concurrent writers can't both succeed against the same tip. If the CAS
 * fails (`changes === 0`) we re-read and retry up to `MAX_AUDIT_RETRIES`
 * times. Under SQLite/D1's serialised writer this loop converges quickly;
 * an exhausted retry budget throws so callers can surface the failure.
 */
export async function audit(env: AuditWriterEnv, args: AuditArgs): Promise<void> {
  for (let attempt = 0; attempt < MAX_AUDIT_RETRIES; attempt++) {
    const { statement } = await buildAuditInsert(env, args);
    const res = await statement.run();
    if (res.meta && res.meta.changes && res.meta.changes > 0) return;
    // changes === 0 → contention. Loop and re-read the tip.
  }
  throw new Error('audit: CAS exhausted after retries');
}
