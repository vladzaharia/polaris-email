-- 0006_operators_split.sql
--
-- Splits operators from mailboxes:
--   * Drops the `principals` table (it existed only to host one row per
--     operator under a fake mailbox FK).
--   * Drops the sentinel mailbox `01J0000000000000000000PLRS`.
--   * Rewires `api_keys.principal_id` -> `api_keys.operator_id` (FK to
--     operators(id) ON DELETE CASCADE).
--   * Drops `operators.api_key_id` (the current-key pointer is now
--     derived: `api_keys WHERE operator_id = ? AND status = 'primary'`).
--   * Drops `messages.principal_id` (carried no info that audit_log
--     doesn't already record).
--   * Backfills the bootstrap-admin api_key as the first operator row
--     (`01J0000000000000000000ROOT`).
--
-- Pre-production: no users to coordinate with. Clean cut, one migration.
--
-- IMPORTANT: D1 ignores `PRAGMA foreign_keys = OFF` inside a migration
-- transaction. The ordering below works with FK enforcement enabled:
--   * DROP TABLE does not fail due to dangling incoming FKs; SQLite
--     tolerates them as "phantom" until the target re-exists or a
--     write attempts to validate.
--   * SELECT never triggers FK validation; only INSERT/UPDATE/DELETE.
--   * The rebuild order detaches each FK before its target is dropped.

-- ============================================================================
-- 1. Backfill the bootstrap-admin api_key as the root operator.
--    Must happen before the api_keys rebuild (which JOINs through this row).
-- ============================================================================

INSERT INTO operators (
  id, name, email, ssh_pubkey, ssh_pubkey_fp_sha256, api_key_id, role,
  created_at, updated_at
)
SELECT
  '01J0000000000000000000ROOT',
  'root',
  'root@polaris-mail.invalid',
  '',
  'sha256:bootstrap-admin-no-pubkey',
  b.admin_key_id,
  'admin',
  COALESCE(b.consumed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  COALESCE(b.consumed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
FROM bootstrap b
WHERE b.admin_key_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM operators WHERE api_key_id = b.admin_key_id
  );

-- Any api_keys row not linked to an operator is pre-0003 legacy.
-- Delete first so the api_keys rebuild's NOT NULL operator_id holds.
DELETE FROM api_keys
WHERE id NOT IN (SELECT api_key_id FROM operators);

-- ============================================================================
-- 2. Drop views that reference `messages` before the messages rebuild.
--    Unused in application code; not recreated.
-- ============================================================================

DROP VIEW IF EXISTS v_message_with_latest_attempt;
DROP VIEW IF EXISTS v_message_delivery_state;

-- ============================================================================
-- 3. Rebuild api_keys: replace principal_id with operator_id.
--    Reads the operator mapping from the existing operators.api_key_id
--    column before the operators table is itself rebuilt in step 4.
-- ============================================================================

CREATE TABLE api_keys_new (
  id                 TEXT PRIMARY KEY,
  operator_id        TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  prefix             TEXT NOT NULL,
  secret_argon2id    TEXT NOT NULL,
  scopes             TEXT NOT NULL,
  rate_limit_per_min INTEGER NOT NULL DEFAULT 60,
  status             TEXT NOT NULL DEFAULT 'primary'
                       CHECK(status IN ('primary','secondary','revoked')),
  created_at         TEXT NOT NULL,
  last_used_at       TEXT,
  last_used_ip       TEXT,
  last_used_ua       TEXT,
  revoked_at         TEXT,
  disabled_at        TEXT
);

INSERT INTO api_keys_new (
  id, operator_id, prefix, secret_argon2id, scopes, rate_limit_per_min,
  status, created_at, last_used_at, last_used_ip, last_used_ua,
  revoked_at, disabled_at
)
SELECT
  k.id, o.id, k.prefix, k.secret_argon2id, k.scopes, k.rate_limit_per_min,
  k.status, k.created_at, k.last_used_at, k.last_used_ip, k.last_used_ua,
  k.revoked_at, k.disabled_at
FROM api_keys k
JOIN operators o ON o.api_key_id = k.id;

DROP TABLE api_keys;
ALTER TABLE api_keys_new RENAME TO api_keys;

CREATE INDEX idx_api_keys_operator_id ON api_keys(operator_id);
CREATE INDEX idx_api_keys_status      ON api_keys(status);

-- ============================================================================
-- 4. Rebuild operators: drop the api_key_id column. The reverse FK
--    direction (api_keys.operator_id -> operators.id) is set up in step 3
--    and points at the new api_keys table.
-- ============================================================================

CREATE TABLE operators_new (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  email                TEXT NOT NULL UNIQUE,
  ssh_pubkey           TEXT NOT NULL,
  ssh_pubkey_fp_sha256 TEXT NOT NULL UNIQUE,
  role                 TEXT NOT NULL DEFAULT 'operator'
                         CHECK(role IN ('admin','operator','readonly')),
  disabled_at          TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  last_seen_at         TEXT
);

INSERT INTO operators_new (
  id, name, email, ssh_pubkey, ssh_pubkey_fp_sha256, role,
  disabled_at, created_at, updated_at, last_seen_at
)
SELECT
  id, name, email, ssh_pubkey, ssh_pubkey_fp_sha256, role,
  disabled_at, created_at, updated_at, last_seen_at
FROM operators;

DROP TABLE operators;
ALTER TABLE operators_new RENAME TO operators;

CREATE INDEX        idx_operators_disabled_at ON operators(disabled_at);
CREATE UNIQUE INDEX uniq_operators_fp_active
  ON operators(ssh_pubkey_fp_sha256) WHERE disabled_at IS NULL;

CREATE TRIGGER trg_operators_updated_at
AFTER UPDATE ON operators
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE operators
  SET    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE  id = NEW.id;
END;

-- ============================================================================
-- 5. Rebuild messages: drop principal_id. The from_addr_normalized
--    generated column is preserved verbatim.
-- ============================================================================

CREATE TABLE messages_new (
  id                      TEXT PRIMARY KEY,
  mailbox_id              TEXT NOT NULL REFERENCES mailboxes(id),
  bridge_id               TEXT REFERENCES bridges(id),
  direction               TEXT NOT NULL CHECK(direction IN ('in','out')),
  status                  TEXT NOT NULL CHECK(status IN (
                            'received','mime_stored','queued','sending',
                            'sent','bounced','delivered','failed','held'
                          )),
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
  bounced_at              TEXT,
  bounce_metadata         TEXT,
  last_error              TEXT,
  auth_spf                TEXT,
  auth_dkim               TEXT,
  auth_dmarc              TEXT,
  auth_remote_ip          TEXT,
  stream_type             TEXT NOT NULL DEFAULT 'transactional'
                            CHECK(stream_type IN ('transactional','marketing','agent','inbound')),
  policy_decision_id      TEXT,
  created_at              TEXT NOT NULL
);

INSERT INTO messages_new (
  id, mailbox_id, bridge_id, direction, status,
  from_addr, to_addrs, subject, r2_key, content_sha256,
  parsed_json, body_bytes, attachments_total_bytes,
  idempotency_key, message_id_header, header_message_id, thread_id,
  send_attempt_id, received_at_bridge, received_at_api, queued_at,
  sending_at, sent_at, delivered_at, failed_at, bounced_at,
  bounce_metadata, last_error, auth_spf, auth_dkim, auth_dmarc,
  auth_remote_ip, stream_type, policy_decision_id, created_at
)
SELECT
  id, mailbox_id, bridge_id, direction, status,
  from_addr, to_addrs, subject, r2_key, content_sha256,
  parsed_json, body_bytes, attachments_total_bytes,
  idempotency_key, message_id_header, header_message_id, thread_id,
  send_attempt_id, received_at_bridge, received_at_api, queued_at,
  sending_at, sent_at, delivered_at, failed_at, bounced_at,
  bounce_metadata, last_error, auth_spf, auth_dkim, auth_dmarc,
  auth_remote_ip, stream_type, policy_decision_id, created_at
FROM messages;

DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;

CREATE INDEX idx_messages_mailbox_created        ON messages(mailbox_id, created_at DESC);
CREATE INDEX idx_messages_mailbox_dir_status     ON messages(mailbox_id, direction, status);
CREATE INDEX idx_messages_mailbox_status_created ON messages(mailbox_id, status, created_at DESC);
CREATE INDEX idx_messages_direction_status_at    ON messages(direction, status, created_at DESC);
CREATE INDEX idx_messages_from_normalized        ON messages(from_addr_normalized);
CREATE INDEX idx_messages_content_sha256         ON messages(content_sha256);
CREATE INDEX idx_messages_idempotency_key        ON messages(idempotency_key);
CREATE INDEX idx_messages_mailbox_thread         ON messages(mailbox_id, thread_id, created_at DESC);

-- ============================================================================
-- 6. Drop principals + sentinel mailbox. After the rebuilds in steps 3 + 5,
--    no remaining table references principals — DROP is safe with FK on.
-- ============================================================================

DROP TABLE principals;

DELETE FROM mailboxes WHERE id = '01J0000000000000000000PLRS';

-- ============================================================================
-- Version stamp
-- ============================================================================
INSERT INTO schema_migrations (version, applied_at, sha)
VALUES (6, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '0006_operators_split');
