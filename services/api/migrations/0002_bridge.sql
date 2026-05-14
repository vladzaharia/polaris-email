-- polaris-email — Phase L bridge tables (schema version=2)
--
-- Adds the IMAP / JMAP / unified-credential schema needed by `apps/mail-bridge`.
-- Append-only on top of `0001_init.sql`. This file lands in slice L.1; the
-- backend endpoints that read/write these tables ship in slice L.3, the Go
-- bridge code that drives them ships in slice L.2.
--
-- ============================================================================
-- Tables added here
-- ============================================================================
--  * mailbox_messages_state    — per-(mailbox, message) IMAP flags + UID + JMAP
--                                change_id. Materialized on first IMAP access.
--  * mailbox_uid_counter       — monotonic UID allocator per mailbox (single
--                                INBOX model → one counter per mailbox).
--  * mailbox_change_counter    — monotonic change-id allocator per mailbox.
--                                Powers IMAP MODSEQ / CONDSTORE and JMAP
--                                Email/changes state tokens.
--  * mailbox_credentials       — unified credential table. SMTPS uses
--                                protocol='smtps' + auth_type='password';
--                                IMAP uses protocol='imap' + 'password';
--                                JMAP uses protocol='jmap' + 'bearer_token'.
--                                One mailbox can hold all three.
--  * jmap_push_subscriptions   — active JMAP push subscribers (WebSocket and
--                                EventSource).
--
-- FK ON DELETE policy: every mailbox-scoped row cascades on mailbox delete.
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ===========================================================================
-- Per-(mailbox, message) IMAP + JMAP state
-- ===========================================================================
-- One row per (mailbox_id, message_id). Materialized lazily on first IMAP
-- access to a message that has no existing row.
--
-- flags_json: JSON array. System flags use IMAP backslash form
-- (`\Seen`, `\Answered`, `\Flagged`, `\Deleted`); custom keywords are bare
-- strings. Note: `\Draft` is intentionally not supported (INBOX-only model).
--
-- uid          : monotonic per mailbox, allocated from `mailbox_uid_counter`.
-- uid_validity : per-mailbox UIDVALIDITY; bumps when the UID space is rebuilt.
-- change_id    : monotonic per mailbox, allocated from `mailbox_change_counter`.
--                Powers IMAP MODSEQ (RFC 7162 / CONDSTORE) and JMAP
--                `Email/changes` state tokens.
-- read_at      : NULL = unread. Bumped to `\Seen` flag and a real timestamp on
--                first read.
-- expunged_at  : soft-delete marker. Janitor honors this for hard delete.
CREATE TABLE mailbox_messages_state (
  message_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  mailbox_id   TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  read_at      TEXT,
  expunged_at  TEXT,
  flags_json   TEXT NOT NULL DEFAULT '[]',
  uid          INTEGER NOT NULL,
  uid_validity INTEGER NOT NULL,
  change_id    INTEGER NOT NULL,
  PRIMARY KEY (mailbox_id, message_id)
);
CREATE INDEX idx_mailbox_messages_state_change
  ON mailbox_messages_state(mailbox_id, change_id);
CREATE INDEX idx_mailbox_messages_state_uid
  ON mailbox_messages_state(mailbox_id, uid);
CREATE INDEX idx_mailbox_messages_state_expunged
  ON mailbox_messages_state(mailbox_id, expunged_at);

-- ===========================================================================
-- UID + change-id counters (sidecar allocator tables)
-- ===========================================================================
-- Sequential UID allocator per mailbox. Single INBOX model → one counter per
-- mailbox is sufficient (no folder dimension needed).
CREATE TABLE mailbox_uid_counter (
  mailbox_id   TEXT PRIMARY KEY REFERENCES mailboxes(id) ON DELETE CASCADE,
  next_uid     INTEGER NOT NULL DEFAULT 1,
  uid_validity INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);

-- Monotonic change-id allocator per mailbox. Bumped on every state-changing
-- mutation (arrival, flag change, expunge). Drives both CONDSTORE MODSEQ
-- and JMAP Email/changes deltas.
CREATE TABLE mailbox_change_counter (
  mailbox_id     TEXT PRIMARY KEY REFERENCES mailboxes(id) ON DELETE CASCADE,
  next_change_id INTEGER NOT NULL DEFAULT 1
);

-- ===========================================================================
-- Unified mail credentials (SMTPS + IMAP + JMAP)
-- ===========================================================================
-- One row per (mailbox, protocol, username|bearer-token). The same operator
-- on the same mailbox can hold all three protocols simultaneously.
--
-- * password rows    : `username` + `bcrypt_hash` set, `bearer_token` NULL.
--                      Used for IMAP LOGIN/AUTH PLAIN and SMTPS AUTH.
-- * bearer_token rows: `bearer_token` set, `username` + `bcrypt_hash` NULL.
--                      Used for JMAP Authorization headers.
--
-- Replaces the prior split between `submission_credentials` (SMTPS) and the
-- never-shipped `mailbox_imap_credentials`. SMTPS migration to this table
-- happens in a later slice (services/api still reads submission_credentials
-- today).
CREATE TABLE mailbox_credentials (
  id            TEXT PRIMARY KEY,
  mailbox_id    TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  protocol      TEXT NOT NULL CHECK(protocol IN ('imap','jmap','smtps')),
  auth_type     TEXT NOT NULL CHECK(auth_type IN ('password','bearer_token')),
  username      TEXT,
  bcrypt_hash   TEXT,
  bearer_token  TEXT,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT,
  disabled_at   TEXT,
  UNIQUE(mailbox_id, protocol, username)
);
CREATE INDEX idx_mailbox_credentials_mailbox_id
  ON mailbox_credentials(mailbox_id);
CREATE INDEX idx_mailbox_credentials_protocol
  ON mailbox_credentials(mailbox_id, protocol);

-- ===========================================================================
-- JMAP push subscriptions
-- ===========================================================================
-- One row per active JMAP push subscriber. WebSocket (RFC 8887) is the
-- primary transport; EventSource (RFC 8620 alternate) is the SSE fallback.
-- Expiry is honored by the bridge's push manager; janitor sweeps stale rows.
CREATE TABLE jmap_push_subscriptions (
  id          TEXT PRIMARY KEY,
  mailbox_id  TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  device_id   TEXT NOT NULL,
  push_type   TEXT NOT NULL CHECK(push_type IN ('websocket','eventsource')),
  expires_at  TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_jmap_push_subscriptions_mailbox
  ON jmap_push_subscriptions(mailbox_id);
CREATE INDEX idx_jmap_push_subscriptions_expires
  ON jmap_push_subscriptions(expires_at);

-- ===========================================================================
-- Version stamp
-- ===========================================================================
INSERT INTO schema_migrations (version, applied_at, sha)
VALUES (2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '0002_bridge');
