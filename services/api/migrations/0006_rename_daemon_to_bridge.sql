-- polaris-email — rename daemons -> bridges (schema version=6)
--
-- Phase B4 (cleanup plan): align the persistence layer with the "bridge"
-- terminology that the rest of the codebase uses ("mail-bridge" Go binary,
-- bridge HMAC, bridge credentials). Hard cutover — no view aliases, no dual
-- writes, no graceful coexistence window.
--
-- ============================================================================
-- What this migration changes
-- ============================================================================
--  * `daemons` table renamed to `bridges`.
--  * `submission_credentials.daemon_id` renamed to `bridge_id` (plus index).
--  * `messages.daemon_id` renamed to `bridge_id` (FK retargeted to bridges.id).
--  * `messages.received_at_daemon` renamed to `received_at_bridge`.
--  * `audit_log.action` CHECK widened to recognise `bridge.*` actions and
--    rewrite the existing rows from `daemon.*` to `bridge.*`. The legacy
--    `daemon.*` names are removed from the constraint (hard cutover).
--
-- ============================================================================
-- SQLite limitations addressed
-- ============================================================================
--  * `ALTER TABLE ... RENAME COLUMN` is supported (SQLite ≥ 3.25) and is used
--    for the column renames on `submission_credentials` and on `messages`.
--    The FK definition on the renamed `messages.bridge_id` column still
--    references the old table name as a string literal inside the SQL
--    schema — SQLite stores the original CREATE TABLE text, so we rebuild
--    the `messages` table to retarget the FK at the new `bridges` table.
--  * `audit_log` has a CHECK constraint we cannot widen in place, so it gets
--    the rename / recreate / copy / drop dance (matches 0003_audit_actions).
--    Existing rows have their action string rewritten in the same pass.

PRAGMA foreign_keys = OFF;

-- ===========================================================================
-- 1. Rename the daemons table.
-- ===========================================================================
ALTER TABLE daemons RENAME TO bridges;

-- ===========================================================================
-- 2. submission_credentials.daemon_id -> bridge_id (+ rebuild index).
-- ===========================================================================
DROP INDEX IF EXISTS idx_submission_credentials_daemon_id;
ALTER TABLE submission_credentials RENAME COLUMN daemon_id TO bridge_id;
CREATE INDEX idx_submission_credentials_bridge_id
  ON submission_credentials(bridge_id);

-- ===========================================================================
-- 3. messages.daemon_id -> bridge_id (column rename + FK retarget) and
--    messages.received_at_daemon -> received_at_bridge.
--
-- SQLite RENAME COLUMN updates the column name in stored DDL but leaves the
-- FK target string ("REFERENCES daemons(id)") untouched. Since `daemons`
-- itself is now renamed to `bridges`, the FK target is dangling. Rebuild the
-- messages table to fix the FK target while we're here.
-- ===========================================================================

-- Capture index DDL up front so we can recreate verbatim after the swap.
-- The index list is hard-coded from 0001_init.sql to keep this migration
-- self-contained (D1's preview environments don't expose sqlite_master
-- helpers reliably). Keep in lockstep with 0001_init.sql `messages` indexes.

ALTER TABLE messages RENAME TO messages_old;

CREATE TABLE messages (
  id                      TEXT PRIMARY KEY,
  mailbox_id              TEXT NOT NULL REFERENCES mailboxes(id),
  principal_id            TEXT REFERENCES principals(id),
  bridge_id               TEXT REFERENCES bridges(id),
  direction               TEXT NOT NULL CHECK(direction IN ('in','out')),
  status                  TEXT NOT NULL CHECK(status IN (
                            'received','mime_stored','queued','sending',
                            'sent','bounced','delivered','failed')),
  from_addr               TEXT NOT NULL,
  from_addr_normalized    TEXT GENERATED ALWAYS AS (LOWER(from_addr)) STORED,
  to_addrs                TEXT,
  subject                 TEXT,
  r2_key                  TEXT NOT NULL,
  content_sha256          TEXT NOT NULL,
  parsed_json             TEXT,
  body_bytes              INTEGER,
  attachments_total_bytes INTEGER,
  idempotency_key         TEXT,
  message_id_header       TEXT,
  header_message_id       TEXT,
  thread_id               TEXT,
  send_attempt_id         TEXT,
  received_at_bridge      TEXT,
  received_at_api         TEXT,
  queued_at               TEXT,
  sending_at              TEXT,
  sent_at                 TEXT,
  delivered_at            TEXT,
  failed_at               TEXT,
  bounce_metadata         TEXT,
  last_error              TEXT,
  auth_spf                TEXT,
  auth_dkim               TEXT,
  auth_dmarc              TEXT,
  auth_remote_ip          TEXT,
  created_at              TEXT NOT NULL
);

-- The old table still uses the legacy `daemon_id` + `received_at_daemon`
-- column names. Copy by enumerating every column in the new shape and
-- mapping the two renamed columns from their legacy names.
INSERT INTO messages (
  id, mailbox_id, principal_id, bridge_id, direction, status,
  from_addr, to_addrs, subject, r2_key, content_sha256, parsed_json,
  body_bytes, attachments_total_bytes, idempotency_key, message_id_header,
  header_message_id, thread_id, send_attempt_id, received_at_bridge,
  received_at_api, queued_at, sending_at, sent_at, delivered_at, failed_at,
  bounce_metadata, last_error, auth_spf, auth_dkim, auth_dmarc,
  auth_remote_ip, created_at
)
SELECT
  id, mailbox_id, principal_id, daemon_id, direction, status,
  from_addr, to_addrs, subject, r2_key, content_sha256, parsed_json,
  body_bytes, attachments_total_bytes, idempotency_key, message_id_header,
  header_message_id, thread_id, send_attempt_id, received_at_daemon,
  received_at_api, queued_at, sending_at, sent_at, delivered_at, failed_at,
  bounce_metadata, last_error, auth_spf, auth_dkim, auth_dmarc,
  auth_remote_ip, created_at
FROM messages_old;

DROP TABLE messages_old;

CREATE INDEX idx_messages_mailbox_created     ON messages(mailbox_id, created_at DESC);
CREATE INDEX idx_messages_mailbox_dir_status  ON messages(mailbox_id, direction, status);
CREATE INDEX idx_messages_direction_status_at ON messages(direction, status, created_at DESC);
CREATE INDEX idx_messages_from_normalized     ON messages(from_addr_normalized);
CREATE INDEX idx_messages_content_sha256      ON messages(content_sha256);
CREATE INDEX idx_messages_idempotency_key     ON messages(idempotency_key);
CREATE INDEX idx_messages_mailbox_thread      ON messages(mailbox_id, thread_id, created_at DESC);
CREATE INDEX idx_messages_header_message_id   ON messages(header_message_id);

-- ===========================================================================
-- 4. audit_log: widen CHECK to bridge.* actions, rewrite existing rows.
--
-- Same rename/recreate/copy/drop pattern as 0003_audit_actions.sql. Rows
-- whose action was `daemon.*` are rewritten to `bridge.*` in the copy step.
-- ===========================================================================

ALTER TABLE audit_log RENAME TO audit_log_old;

CREATE TABLE audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  actor     TEXT NOT NULL,
  action    TEXT NOT NULL CHECK(action IN (
              -- bootstrap
              'bootstrap.consume',
              -- mailbox CRUD
              'mailbox.create','mailbox.update','mailbox.disable','mailbox.delete',
              -- mailbox bridge ops
              'mailbox.expunge',
              -- sender CRUD
              'mailbox_sender.create','mailbox_sender.update','mailbox_sender.disable','mailbox_sender.delete',
              'email_sender.create','email_sender.disable',
              -- receiver CRUD
              'mailbox_receiver.create','mailbox_receiver.update','mailbox_receiver.disable','mailbox_receiver.delete',
              'routing_rule.create','routing_rule.update','routing_rule.delete',
              -- credential lifecycle
              'api_key.issue','api_key.rotate','api_key.rotate.emergency','api_key.revoke',
              'api_key.revoke.emergency',
              'smtp_credential.issue','smtp_credential.disable','smtp_credential.rotate',
              -- unified mailbox credentials
              'mailbox_credential.issue','mailbox_credential.rotate','mailbox_credential.disable',
              'dry_run_rotate',
              -- bridge lifecycle (renamed from daemon.* in B4)
              'bridge.register','bridge.rotate','bridge.deregister',
              -- domain + DKIM
              'domain.create','domain.update','domain.disable',
              'domain.verify','domain.verify_incomplete','domain.dkim_rotate',
              'domain.inbound.enable','domain.inbound.disable',
              'domain.outbound.enable','domain.outbound.disable',
              -- dkim_key direct events
              'dkim_key.create','dkim_key.activate','dkim_key.retire',
              -- webhook subs + DLQ
              'webhook_sub.create','webhook_sub.update','webhook_sub.delete','webhook_sub.replay',
              'webhook_sub.test',
              -- messages
              'message.submitted','message.received','message.marked_read','message.expunged',
              -- rate limiting
              'rate_limit.exceeded',
              -- legacy tenant ops
              'tenant.create','tenant.update','tenant.disable','tenant.rotate_pepper'
            )),
  target    TEXT,
  meta      TEXT NOT NULL,
  at        INTEGER NOT NULL,
  prev_hash TEXT NOT NULL,
  row_hash  TEXT NOT NULL
);

-- Rewrite historic daemon.* rows in-place during the copy so the new
-- constraint accepts everything.
INSERT INTO audit_log (id, actor, action, target, meta, at, prev_hash, row_hash)
  SELECT
    id,
    actor,
    CASE action
      WHEN 'daemon.register'   THEN 'bridge.register'
      WHEN 'daemon.rotate'     THEN 'bridge.rotate'
      WHEN 'daemon.deregister' THEN 'bridge.deregister'
      ELSE action
    END,
    target, meta, at, prev_hash, row_hash
  FROM audit_log_old;

DROP TABLE audit_log_old;

CREATE INDEX idx_audit_log_at     ON audit_log(at);
CREATE INDEX idx_audit_log_action ON audit_log(action);
CREATE INDEX idx_audit_log_actor  ON audit_log(actor);

PRAGMA foreign_keys = ON;

-- ===========================================================================
-- Version stamp
-- ===========================================================================
INSERT INTO schema_migrations (version, applied_at, sha)
VALUES (6, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '0006_rename_daemon_to_bridge');
