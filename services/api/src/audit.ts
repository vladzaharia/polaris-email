// Append-only, hash-chained audit log reader/verifier.
//
// The single canonical writer (`audit()`) lives in `@polaris-email/pipeline`
// so services/api, services/in, and services/out all hash-chain through the
// same compare-and-swap. We re-export it here under its previous name so
// existing in-tree callers (admin, messages, bootstrap, messages-state,
// scheduled handlers) keep working unchanged.
//
// Concurrency model is documented in `packages/pipeline/src/audit.ts`.
import type { AuditAction } from '@polaris-email/schema';
import {
  audit as pipelineAudit,
  buildAuditInsert as pipelineBuildAuditInsert,
  type AuditArgs as PipelineAuditArgs,
  type AuditWriterEnv,
} from '@polaris-email/pipeline';
import { sha256Hex } from '@polaris-email/hmac';
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
 * Thin wrapper that narrows `AuditArgs.action` to the schema-validated
 * `AuditAction` enum at API boundaries; the actual CAS retry loop lives in
 * `@polaris-email/pipeline`.
 */
export async function audit(env: Env, args: AuditArgs): Promise<void> {
  return pipelineAudit(env as unknown as AuditWriterEnv, args satisfies PipelineAuditArgs);
}

/**
 * Build a CAS audit-insert prepared statement so a caller can fold the
 * audit-row write into the same `db.batch([...])` as the primary mutation.
 * See `packages/pipeline/src/audit.ts` for the CAS contract.
 */
export async function buildAuditInsert(env: Env, args: AuditArgs) {
  return pipelineBuildAuditInsert(
    env as unknown as AuditWriterEnv,
    args satisfies PipelineAuditArgs,
  );
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
    const expected = await sha256Hex(new TextEncoder().encode(canonical));
    if (expected !== r.row_hash) {
      return { ok: false, brokenAt: r.id, reason: 'row_hash mismatch' };
    }
    prev = r.row_hash;
  }
  return { ok: true };
}
