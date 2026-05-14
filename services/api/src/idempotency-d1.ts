// D1-backed idempotency.
//
// KV is up to 60s eventually consistent — exactly the window where retries land
// in different colos. Two retries of the same key can both miss the cache and
// both write. D1 is single-region serializable; INSERT ... ON CONFLICT
// DO NOTHING ... RETURNING gives us a true atomic claim.
//
// Keys are scoped by `(mailbox_id, idempotency_key)` per the mailbox-centric
// schema (services/api/migrations/0001_init.sql).

import type { Env } from './env.js';

export interface IdemClaim {
  /** True when this caller wins the race; false on duplicate. */
  first: boolean;
  /** When first=false, the previously-claimed message_id. */
  messageId?: string;
}

/**
 * Atomically claim an idempotency key. Returns first=true with no messageId on
 * the winning path; first=false with the previously-claimed messageId on
 * duplicate.
 *
 * Caller MUST follow up with `recordClaim()` after the message row is created
 * (so the idempotency_keys row points at it). Until then, a concurrent reader
 * sees first=false but messageId=null and should retry once after a short delay.
 */
export async function tryClaim(
  env: Env,
  key: string,
  mailboxId: string,
  principalId: string | null,
): Promise<IdemClaim> {
  if (!key) {
    throw new Error('idempotency key required');
  }
  // SQLite's INSERT OR IGNORE + RETURNING gives us the atomic semantics we need.
  // If a row exists, RETURNING is empty; we then SELECT to fetch the message_id.
  const insert = await env.DB.prepare(
    `INSERT OR IGNORE INTO idempotency_keys (key, mailbox_id, principal_id, message_id, created_at)
       VALUES (?1, ?2, ?3, NULL, ?4)
       RETURNING key`,
  )
    .bind(key, mailboxId, principalId, new Date().toISOString())
    .first<{ key: string }>();
  if (insert?.key === key) {
    return { first: true };
  }
  // Duplicate — fetch the existing row's message_id (may be null if the original
  // request hasn't reached recordClaim() yet).
  const row = await env.DB.prepare(`SELECT message_id FROM idempotency_keys WHERE key = ?1`)
    .bind(key)
    .first<{ message_id: string | null }>();
  return { first: false, messageId: row?.message_id ?? undefined };
}

/** Attach the message_id to the claim; called after the messages row is created. */
export async function recordClaim(env: Env, key: string, messageId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE idempotency_keys SET message_id = ?2 WHERE key = ?1 AND message_id IS NULL`,
  )
    .bind(key, messageId)
    .run();
}
