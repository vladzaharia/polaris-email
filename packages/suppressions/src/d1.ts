// D1-aware helpers. Kept in a separate entry so the pure normalization
// helpers in `./index.ts` remain runtime-agnostic.
//
// Both `services/out` (enforcement) and `services/api` (admin REST) consume
// these so the SQL stays in one place.

import type { EnforcementContext, Reason, Source, Severity } from './index.js';
import { isActive, normalizeAddress, senderScopeCandidates } from './index.js';

// Minimal D1 surface we depend on. Mirrors the @cloudflare/workers-types
// shape but redeclared here so this package doesn't need to depend on it.
interface D1Stmt {
  bind(...params: unknown[]): D1Stmt;
  all<T = unknown>(): Promise<{ results: T[] }>;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<unknown>;
}
interface D1 {
  prepare(sql: string): D1Stmt;
}

export interface SuppressionRecord {
  id: string;
  entity_type: 'recipient' | 'sender';
  address_normalized: string;
  scope: 'global' | 'domain' | 'mailbox' | 'sender_address';
  scope_target: string | null;
  reason: Reason;
  source: Source;
  severity: Severity;
  expires_at: string | null;
  disabled_at: string | null;
}

const SELECT_COLS =
  'id, entity_type, address_normalized, scope, scope_target, reason, source, severity, expires_at, disabled_at';

/**
 * Recipient lookup. Returns the first active suppression row for the
 * normalized recipient address that matches the enforcement context's scope
 * candidates (global, plus the sender's domain/mailbox/sender_address if
 * present). Returns null if not suppressed.
 *
 * The query joins one address (the recipient) against multiple scope/target
 * pairs (the sender's identity) — so an "unsubscribe from sender X"
 * suppression doesn't accidentally block sends from sender Y.
 */
export async function checkRecipientSuppression(
  db: D1,
  recipient: string,
  ctx: EnforcementContext,
  nowMs = Date.now(),
): Promise<SuppressionRecord | null> {
  const n = normalizeAddress(recipient);
  if (!n) return null;
  const scopes = senderScopeCandidates(ctx);
  const placeholders = scopes
    .map(() => "(scope = ? AND COALESCE(scope_target, '') = ?)")
    .join(' OR ');
  const binds: unknown[] = [n.normalized];
  for (const s of scopes) {
    binds.push(s.scope, s.scope_target ?? '');
  }
  const sql = `SELECT ${SELECT_COLS} FROM suppressions
       WHERE entity_type = 'recipient'
         AND address_normalized = ?
         AND disabled_at IS NULL
         AND (${placeholders})
       ORDER BY severity DESC, created_at DESC LIMIT 8`;
  const rows = await db
    .prepare(sql)
    .bind(...binds)
    .all<SuppressionRecord>();
  for (const r of rows.results ?? []) {
    if (isActive(r.expires_at, nowMs)) return r;
  }
  return null;
}

/**
 * Sender lookup. Checks if the current send context (principal/mailbox/
 * domain/sender_address) matches any active sender suppression. Senders
 * suppressed at any of their containing scopes fail closed — we union the
 * scope candidates and return the most severe match.
 */
export async function checkSenderSuppression(
  db: D1,
  ctx: EnforcementContext,
  nowMs = Date.now(),
): Promise<SuppressionRecord | null> {
  if (!ctx.senderAddress) return null;
  const n = normalizeAddress(ctx.senderAddress);
  if (!n) return null;
  const scopes = senderScopeCandidates(ctx);
  const placeholders = scopes
    .map(() => "(scope = ? AND COALESCE(scope_target, '') = ?)")
    .join(' OR ');
  const binds: unknown[] = [n.normalized];
  for (const s of scopes) {
    binds.push(s.scope, s.scope_target ?? '');
  }
  const sql = `SELECT ${SELECT_COLS} FROM suppressions
       WHERE entity_type = 'sender'
         AND address_normalized = ?
         AND disabled_at IS NULL
         AND (${placeholders})
       ORDER BY severity DESC, created_at DESC LIMIT 8`;
  const rows = await db
    .prepare(sql)
    .bind(...binds)
    .all<SuppressionRecord>();
  for (const r of rows.results ?? []) {
    if (isActive(r.expires_at, nowMs)) return r;
  }
  return null;
}
