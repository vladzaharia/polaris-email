// Mailbox state helpers for the IMAP bridge.
//
// Phase L allocates per-(mailbox, message) state in `mailbox_messages_state`
// the first time IMAP touches a message. The bridge also reads from
// `mailbox_uid_counter` (sequential UID per mailbox) and
// `mailbox_change_counter` (monotonic MODSEQ).
//
// This helper centralises the read-allocate-write dance so every callsite
// (PATCH /v1/messages/:id, POST /v1/mailboxes/:id/expunge, the inbound pipeline
// when it materialises new arrivals, etc.) emits the same SQL.
//
// All operations are intentionally written as a sequence of single-row
// statements; the in-memory mock D1 used in unit tests can't parse JOINs or
// complex UPSERTs, so we keep the SQL shape narrow.

export interface MailboxStateRow {
  message_id: string;
  mailbox_id: string;
  read_at: string | null;
  expunged_at: string | null;
  flags_json: string;
  uid: number;
  uid_validity: number;
  change_id: number;
}

/**
 * Ensure a `mailbox_messages_state` row exists for (mailboxId, messageId).
 * Allocates uid + change_id from the sidecar counter tables on first sight.
 * Returns the row. Idempotent.
 */
export async function ensureMailboxState(
  db: D1Database,
  mailboxId: string,
  messageId: string,
): Promise<MailboxStateRow> {
  const existing = await db
    .prepare(
      `SELECT message_id, mailbox_id, read_at, expunged_at, flags_json, uid, uid_validity, change_id
       FROM mailbox_messages_state
       WHERE mailbox_id = ?1 AND message_id = ?2 LIMIT 1`,
    )
    .bind(mailboxId, messageId)
    .first<MailboxStateRow>();
  if (existing) return existing;

  // 4a.3: atomic UID allocation. UPDATE ... RETURNING in one round-trip
  // avoids the SELECT-then-UPDATE race that previously assigned duplicate
  // UIDs under concurrent message arrivals.
  let uid: number;
  let uidValidity: number;
  const updated = await db
    .prepare(
      `UPDATE mailbox_uid_counter
         SET next_uid = next_uid + 1
       WHERE mailbox_id = ?1
       RETURNING next_uid AS next_uid, uid_validity`,
    )
    .bind(mailboxId)
    .first<{ next_uid: number; uid_validity: number }>()
    .catch(() => null);
  if (updated) {
    uid = updated.next_uid - 1;
    uidValidity = updated.uid_validity;
  } else {
    // Cold path: bootstrap. INSERT OR IGNORE so two concurrent first-touchers
    // don't both insert; the loser retries the UPDATE.
    const seedValidity = Math.floor(Date.now() / 1000);
    const inserted = await db
      .prepare(
        `INSERT OR IGNORE INTO mailbox_uid_counter (mailbox_id, next_uid, uid_validity)
         VALUES (?1, 2, ?2)
         RETURNING uid_validity`,
      )
      .bind(mailboxId, seedValidity)
      .first<{ uid_validity: number }>()
      .catch(() => null);
    if (inserted) {
      uid = 1;
      uidValidity = inserted.uid_validity;
    } else {
      const retry = await db
        .prepare(
          `UPDATE mailbox_uid_counter
             SET next_uid = next_uid + 1
           WHERE mailbox_id = ?1
           RETURNING next_uid AS next_uid, uid_validity`,
        )
        .bind(mailboxId)
        .first<{ next_uid: number; uid_validity: number }>();
      if (!retry) throw new Error('uid allocation lost both insert and update races');
      uid = retry.next_uid - 1;
      uidValidity = retry.uid_validity;
    }
  }

  // Allocate change_id (also atomic via the helper below).
  const changeId = await allocChangeId(db, mailboxId);

  await db
    .prepare(
      `INSERT INTO mailbox_messages_state
        (message_id, mailbox_id, read_at, expunged_at, flags_json, uid, uid_validity, change_id)
       VALUES (?1, ?2, NULL, NULL, '[]', ?3, ?4, ?5)`,
    )
    .bind(messageId, mailboxId, uid, uidValidity, changeId)
    .run();

  return {
    message_id: messageId,
    mailbox_id: mailboxId,
    read_at: null,
    expunged_at: null,
    flags_json: '[]',
    uid,
    uid_validity: uidValidity,
    change_id: changeId,
  };
}

/**
 * Allocate and return the next mailbox change_id. Bumps the counter row.
 * Callers stamp the returned value onto the affected state row.
 *
 * 4a.3: atomic via UPDATE ... RETURNING (was SELECT-then-UPDATE which
 * raced with concurrent state mutations).
 */
export async function allocChangeId(db: D1Database, mailboxId: string): Promise<number> {
  const updated = await db
    .prepare(
      `UPDATE mailbox_change_counter
         SET next_change_id = next_change_id + 1
       WHERE mailbox_id = ?1
       RETURNING next_change_id AS next_change_id`,
    )
    .bind(mailboxId)
    .first<{ next_change_id: number }>()
    .catch(() => null);
  if (updated) return updated.next_change_id - 1;
  // Cold path: bootstrap.
  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO mailbox_change_counter (mailbox_id, next_change_id)
       VALUES (?1, 2)
       RETURNING next_change_id`,
    )
    .bind(mailboxId)
    .first<{ next_change_id: number }>()
    .catch(() => null);
  if (inserted) return 1;
  const retry = await db
    .prepare(
      `UPDATE mailbox_change_counter
         SET next_change_id = next_change_id + 1
       WHERE mailbox_id = ?1
       RETURNING next_change_id AS next_change_id`,
    )
    .bind(mailboxId)
    .first<{ next_change_id: number }>();
  if (!retry) throw new Error('change_id allocation lost both insert and update races');
  return retry.next_change_id - 1;
}

/**
 * Reference-counted purge of `messages.r2_key`. The same R2 object can back
 * multiple `messages` rows (content-addressed dedup); we only delete the R2
 * object when no other row references it.
 *
 * Returns true if R2 was actually deleted; false if the object stayed live
 * because another message still points at it.
 */
export async function purgeMessageRow(
  env: { DB: D1Database; R2: { delete: (key: string) => Promise<unknown> } },
  row: { id: string; r2_key: string },
): Promise<{ r2_deleted: boolean }> {
  const other = await env.DB
    .prepare(`SELECT 1 AS one FROM messages WHERE r2_key = ?1 AND id <> ?2 LIMIT 1`)
    .bind(row.r2_key, row.id)
    .first<{ one: number }>()
    .catch(() => null);
  let r2Deleted = false;
  if (!other) {
    try {
      await env.R2.delete(row.r2_key);
      r2Deleted = true;
    } catch {
      // R2 already gone; proceed.
    }
  }
  await env.DB.prepare(`DELETE FROM messages WHERE id = ?1`).bind(row.id).run();
  return { r2_deleted: r2Deleted };
}
