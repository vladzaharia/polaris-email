-- polaris-email — read-once secrets policy enforcement (schema version=5)
--
-- Cleanup plan B6 + A11: schema and code together make it impossible to read a
-- secret twice. The DB only ever stores *hashes* of issuance-time plaintext;
-- the plaintext itself is returned in the issue/rotate HTTP response body
-- exactly once and never persists outside that response.
--
-- ============================================================================
-- HARD CUTOVER — maintenance window required.
-- ============================================================================
-- Per the plan, every existing secret-bearing row is regenerated in the same
-- maintenance window this migration runs in. There is no overlap period.
-- Operators must:
--   1. Drain inbound + outbound traffic (or accept a brief outage).
--   2. Apply this migration.
--   3. Re-issue every api_key, submission_credential, mailbox_credential,
--      and daemon HMAC key. Distribute the new plaintext secrets out-of-band.
--   4. Restart workers / panels / bridges to pick up the new secrets.
--
-- ============================================================================
-- What this migration drops
-- ============================================================================
--  * `mailbox_credentials.bearer_token`
--      Plaintext JMAP bearer-token column. JMAP is being deleted entirely (C1)
--      in the same maintenance window, so we drop both the column AND every
--      `auth_type='bearer_token'` / `protocol='jmap'` row. The accompanying
--      CHECK constraint is rewritten to forbid those values going forward.
--  * `bootstrap.admin_key_secret`
--      Plaintext slot in the singleton bootstrap row. The bootstrap route
--      (services/api/src/routes/bootstrap.ts) never persists the plaintext —
--      it returns it once in the response body. The column was a never-used
--      legacy slot; dropping it removes the last plaintext-secret column in
--      the schema.
--
-- ============================================================================
-- What this migration leaves alone (already conforming)
-- ============================================================================
--  * `principals` — has NO plaintext column. Secrets live on `api_keys`
--      (see below).
--  * `api_keys.secret_argon2id` — already a PBKDF2/argon2id hash. Plaintext
--      is returned ONCE at POST /v1/admin/api-keys and POST /.../rotate.
--  * `submission_credentials.bcrypt_hash` — already a bcrypt hash. Plaintext
--      is returned ONCE at POST /v1/admin/senders/:id/smtp-credentials.
--  * `mailbox_credentials.bcrypt_hash` — already a bcrypt hash. Plaintext
--      is returned ONCE at POST /v1/admin/mailboxes/:id/credentials and
--      POST /.../rotate.
--  * `daemons.hmac_key_secret_name` — despite the legacy name, the column
--      stores the argon2id hash of the HMAC key. Plaintext is returned ONCE
--      at POST /v1/admin/daemons and POST /.../rotate. The B4 rename
--      migration (`daemons` -> `bridges`, column -> `hmac_key_hash`) is
--      explicitly out of scope here.
--  * `webhook_subs.secret` / `.secret_prev` — these are NOT issuance-time
--      shared secrets: the polaris API itself signs every webhook delivery
--      and the subscriber verifies. The signer (services/fanout) needs the
--      plaintext at delivery time, so hashing here would break signing.
--      The plaintext is set by the API on creation, retained server-side,
--      and rotated atomically.
--
-- ============================================================================
-- Order of operations
-- ============================================================================
-- SQLite (D1 ≥ 3.45) supports `ALTER TABLE ... DROP COLUMN` directly, but the
-- CHECK constraint on `mailbox_credentials.auth_type` needs the multi-step
-- rename/recreate pattern because SQLite cannot rewrite a CHECK in place.

PRAGMA foreign_keys = OFF;

-- ===========================================================================
-- 1. Purge JMAP rows + drop bearer_token plaintext column.
-- ===========================================================================
-- 1a. Hard-delete the JMAP/bearer-token rows. Parallel agent C1 deletes the
--     JMAP code paths; with this migration the rows are unreachable anyway.
DELETE FROM mailbox_credentials
WHERE auth_type = 'bearer_token'
   OR protocol = 'jmap';

-- 1b. Recreate the table with the narrowed CHECK + without bearer_token.
ALTER TABLE mailbox_credentials RENAME TO mailbox_credentials_old;

CREATE TABLE mailbox_credentials (
  id            TEXT PRIMARY KEY,
  mailbox_id    TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  -- jmap removed (C1); only smtps + imap survive.
  protocol      TEXT NOT NULL CHECK(protocol IN ('imap','smtps')),
  -- bearer_token removed (C1 + B6); password is the only auth type now.
  auth_type     TEXT NOT NULL CHECK(auth_type IN ('password')),
  username      TEXT NOT NULL,
  -- Plaintext password column is forbidden; only the hash is persisted.
  bcrypt_hash   TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT,
  disabled_at   TEXT,
  UNIQUE(mailbox_id, protocol, username)
);

-- Hash-only copy: username and bcrypt_hash are NOT NULL in the new shape, so
-- any surviving row whose hash got lost would fail the copy. Rows that fail
-- the new constraints are dropped silently (consistent with the hard-cutover
-- contract — operators re-issue everything anyway).
INSERT OR IGNORE INTO mailbox_credentials
  (id, mailbox_id, protocol, auth_type, username, bcrypt_hash,
   created_at, last_used_at, disabled_at)
SELECT id, mailbox_id, protocol, auth_type, username, bcrypt_hash,
       created_at, last_used_at, disabled_at
FROM mailbox_credentials_old
WHERE auth_type = 'password'
  AND protocol IN ('imap','smtps')
  AND username IS NOT NULL
  AND bcrypt_hash IS NOT NULL;

DROP TABLE mailbox_credentials_old;

CREATE INDEX idx_mailbox_credentials_mailbox_id
  ON mailbox_credentials(mailbox_id);
CREATE INDEX idx_mailbox_credentials_protocol
  ON mailbox_credentials(mailbox_id, protocol);

-- ===========================================================================
-- 2. Drop bootstrap.admin_key_secret (never-written plaintext slot).
-- ===========================================================================
ALTER TABLE bootstrap DROP COLUMN admin_key_secret;

-- ===========================================================================
-- 3. JMAP push subscriptions table is now orphaned (no protocol='jmap' rows).
--    The C1 agent deletes the table; we leave it alone here to avoid stepping
--    on that agent's migration. Rows reference mailbox_id only, so they're
--    safe to leave dangling until C1 lands.
-- ===========================================================================

PRAGMA foreign_keys = ON;

-- ===========================================================================
-- Version stamp
-- ===========================================================================
INSERT INTO schema_migrations (version, applied_at, sha)
VALUES (5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '0005_read_once_secrets');
