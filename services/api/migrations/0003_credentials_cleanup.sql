-- 0003 — Credentials cleanup.
--
-- Drops the legacy credential tables, removes pk_live_ rows from
-- api_keys, and renames mailbox_credentials_v2 into its final name.
-- Polaris Mail is pre-production; per operator policy we don't keep
-- transition tables, deprecated columns, or grace-window code paths.
--
-- After this migration:
--   * mailbox_credentials (renamed from v2) is the sole credential
--     home for all five types (imap/smtp/rest/mcp/cli).
--   * api_keys keeps operator scope only (pk_op_, pk_admin_).
--   * api_key_sender_scopes is gone (mailbox-scope replaces it).
--   * submission_credentials is gone.
--   * legacy mailbox_credentials (v1) is gone.
--   * legacy_username column is gone — operators issue new credentials
--     in the new format rather than coexist with the pre-refactor shape.

PRAGMA foreign_keys = OFF;

-- ============================================================================
-- Drop legacy credential surfaces
-- ============================================================================

DROP TABLE IF EXISTS mailbox_credentials;
DROP TABLE IF EXISTS submission_credentials;
DROP TABLE IF EXISTS api_key_sender_scopes;
DELETE FROM api_keys WHERE prefix = 'pk_live_';

-- The v2 table is recreated under its final name in the next block.
-- We drop instead of ALTER RENAME because:
--   * No data to preserve (pre-production: backfill was zero rows).
--   * RENAME would leave the indexes with `idx_mc2_*` names; cleaner
--     to recreate with correctly-named indexes.
--   * legacy_username column goes away in the same step.
DROP TABLE IF EXISTS mailbox_credentials_v2;

-- ============================================================================
-- Final mailbox_credentials shape
-- ============================================================================

CREATE TABLE mailbox_credentials (
  id                 TEXT PRIMARY KEY,            -- ULID; the kid (printed after the prefix)
  mailbox_id         TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  type               TEXT NOT NULL
                       CHECK(type IN ('imap','smtp','rest','mcp','cli')),
  prefix             TEXT NOT NULL
                       CHECK(prefix IN ('pmimap_','pmsmtp_','pmtk_','pmmcp_','pmcli_')),
  secret_hash        TEXT NOT NULL,               -- $2b$… (bcrypt) for imap/smtp, $pbkdf2-sha256$… for rest/mcp/cli
  secret_prev_hash   TEXT,                        -- planned-rotation grace; nullable
  receiver_id        TEXT REFERENCES mailbox_receivers(id) ON DELETE SET NULL,
  display_name       TEXT,
  status             TEXT NOT NULL DEFAULT 'primary'
                       CHECK(status IN ('primary','secondary','revoked')),
  rate_limit_per_min INTEGER NOT NULL DEFAULT 60,
  created_at         TEXT NOT NULL,
  last_used_at       TEXT,
  last_used_ip       TEXT,
  disabled_at        TEXT,
  revoked_at         TEXT
);

CREATE INDEX idx_mailbox_credentials_mailbox
  ON mailbox_credentials(mailbox_id);
CREATE INDEX idx_mailbox_credentials_type
  ON mailbox_credentials(mailbox_id, type);
CREATE INDEX idx_mailbox_credentials_receiver
  ON mailbox_credentials(receiver_id);

PRAGMA foreign_keys = ON;

-- ============================================================================
-- Version stamp
-- ============================================================================
INSERT INTO schema_migrations (version, applied_at, sha)
VALUES (3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '0003_credentials_cleanup');
