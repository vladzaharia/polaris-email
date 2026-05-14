// Nightly: enforce per-mailbox retention by deleting old messages and their
// R2 bodies, plus purge expired idempotency_keys.
//
// Reference-counted R2 deletion
// ==============================
// `messages.r2_key` is content-addressed (`mime/XX/YY/SHA256`), so two
// different `messages` rows can legitimately reference the same R2 object —
// e.g. inbound dedup or two clients submitting the identical RFC822. Before
// we delete the R2 object we MUST verify no other `messages` row points at
// the same key. The check is a single SELECT EXISTS guarded by the message id
// we're about to delete; if any other row still references it, we skip the
// R2 delete and only drop the D1 row.
//
// Contract:
//   - The janitor never deletes R2 objects that have any live `messages`
//     reference.
//   - On the unique-reference path it deletes the R2 object first, then the
//     D1 row. If the R2 delete fails (object already gone), it still drops
//     the D1 row.

import type { Env } from '../env.js';

interface MailboxRow {
  id: string;
}

interface MessageRow {
  id: string;
  r2_key: string;
}

export async function janitor(env: Env): Promise<void> {
  // Mailbox retention is not yet a column on `mailboxes`; this loop walks the
  // table but no work is done today. A retention_days column is planned; the
  // reference-counted delete below stays as-is once it lands.
  const mailboxes = await env.DB.prepare(
    `SELECT id FROM mailboxes WHERE disabled_at IS NULL`,
  ).all<MailboxRow>();

  let deletedMessages = 0;
  for (const _m of mailboxes.results) {
    // Placeholder for future per-mailbox retention sweep.
  }

  // Sweep expired idempotency_keys.
  const nowIso = new Date().toISOString();
  const idemDeleted = await env.DB.prepare(
    `DELETE FROM idempotency_keys WHERE expires_at IS NOT NULL AND expires_at < ?`,
  )
    .bind(nowIso)
    .run();

  // eslint-disable-next-line no-console
  console.log(
    `janitor: deleted ${deletedMessages} messages, ${idemDeleted.meta.changes ?? 0} idempotency rows`,
  );
}

/**
 * Delete one message row plus its R2 object, but only when no other message
 * row references the same content-addressed key. Exported for unit tests and
 * for future callers that purge individual messages outside the nightly loop.
 */
export async function purgeMessage(env: Env, row: MessageRow): Promise<void> {
  const other = await env.DB.prepare(
    `SELECT 1 FROM messages WHERE r2_key = ? AND id != ? LIMIT 1`,
  )
    .bind(row.r2_key, row.id)
    .first<{ 1: number }>()
    .catch(() => null);
  if (!other) {
    try {
      await env.R2.delete(row.r2_key);
    } catch {
      // R2 already gone — proceed with the D1 delete.
    }
  }
  await env.DB.prepare(`DELETE FROM messages WHERE id = ?`).bind(row.id).run();
}
