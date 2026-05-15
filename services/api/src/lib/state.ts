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

interface DbLike {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      run(): Promise<{ meta?: { changes?: number } }>;
      first<T = unknown>(): Promise<T | null>;
      all<T = unknown>(): Promise<{ results: T[] }>;
    };
  };
}

/**
 * Ensure a `mailbox_messages_state` row exists for (mailboxId, messageId).
 * Allocates uid + change_id from the sidecar counter tables on first sight.
 * Returns the row. Idempotent.
 */
export async function ensureMailboxState(
  db: DbLike | D1Database,
  mailboxId: string,
  messageId: string,
): Promise<MailboxStateRow> {
  const _db = db as DbLike;
  const existing = await _db
    .prepare(
      `SELECT message_id, mailbox_id, read_at, expunged_at, flags_json, uid, uid_validity, change_id
       FROM mailbox_messages_state
       WHERE mailbox_id = ?1 AND message_id = ?2 LIMIT 1`,
    )
    .bind(mailboxId, messageId)
    .first<MailboxStateRow>();
  if (existing) return existing;

  // Allocate UID.
  const uidRow = await _db
    .prepare(`SELECT next_uid, uid_validity FROM mailbox_uid_counter WHERE mailbox_id = ?1`)
    .bind(mailboxId)
    .first<{ next_uid: number; uid_validity: number }>();
  let uid: number;
  let uidValidity: number;
  if (!uidRow) {
    uid = 1;
    uidValidity = Math.floor(Date.now() / 1000);
    await _db
      .prepare(
        `INSERT INTO mailbox_uid_counter (mailbox_id, next_uid, uid_validity)
         VALUES (?1, ?2, ?3)`,
      )
      .bind(mailboxId, uid + 1, uidValidity)
      .run();
  } else {
    uid = uidRow.next_uid;
    uidValidity = uidRow.uid_validity;
    await _db
      .prepare(`UPDATE mailbox_uid_counter SET next_uid = ?1 WHERE mailbox_id = ?2`)
      .bind(uid + 1, mailboxId)
      .run();
  }

  // Allocate change_id.
  const changeId = await allocChangeId(_db, mailboxId);

  await _db
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
 */
export async function allocChangeId(db: DbLike | D1Database, mailboxId: string): Promise<number> {
  const _db = db as DbLike;
  const counter = await _db
    .prepare(`SELECT next_change_id FROM mailbox_change_counter WHERE mailbox_id = ?1`)
    .bind(mailboxId)
    .first<{ next_change_id: number }>();
  let changeId: number;
  if (!counter) {
    changeId = 1;
    await _db
      .prepare(`INSERT INTO mailbox_change_counter (mailbox_id, next_change_id) VALUES (?1, ?2)`)
      .bind(mailboxId, changeId + 1)
      .run();
  } else {
    changeId = counter.next_change_id;
    await _db
      .prepare(`UPDATE mailbox_change_counter SET next_change_id = ?1 WHERE mailbox_id = ?2`)
      .bind(changeId + 1, mailboxId)
      .run();
  }
  return changeId;
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
  env: { DB: DbLike | D1Database; R2: { delete: (key: string) => Promise<unknown> } },
  row: { id: string; r2_key: string },
): Promise<{ r2_deleted: boolean }> {
  const _db = env.DB as DbLike;
  const other = await _db
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
  await _db.prepare(`DELETE FROM messages WHERE id = ?1`).bind(row.id).run();
  return { r2_deleted: r2Deleted };
}
