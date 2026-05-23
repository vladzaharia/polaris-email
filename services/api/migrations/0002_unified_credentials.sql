-- 0002 — Unified mailbox credentials.
--
-- Five credential types (IMAP, SMTP, REST, MCP, CLI) collapse into one
-- table that supersedes:
--   * mailbox_credentials   (IMAP/SMTPS bridge auth, bcrypt, free-form username)
--   * submission_credentials (SMTP send-as, sender-bound 1:1, bcrypt)
--   * api_keys WHERE prefix='pk_live_' (mailbox REST, PBKDF2, sender-scoped via junction)
--
-- The token formats mirror the operator-token scheme verified at
-- services/api/src/routes/admin/operators.ts:255 (polaris_<kid>.<secret>):
--   * IMAP/SMTP — username = '<prefix><kid>', password = <52-char Crockford base32>
--   * REST/MCP/CLI — bearer = '<prefix><kid>.<secret>' (single string)
--
-- Expand-then-contract: this migration ADDS the v2 table and backfills
-- it from the three legacy tables. The legacy tables stay intact and
-- read-only until a follow-up migration drops them (per
-- services/api/migrations/README.md). Verification + bridge lookup keep
-- reading legacy rows during the transition; new issuance writes only
-- to v2.
--
-- Backfill notes:
--   * Legacy IMAP/SMTP usernames (e.g. alice@example.com) are preserved
--     in `legacy_username` so existing MUAs keep authenticating during
--     the transition window — the bridge lookup endpoint accepts either
--     the new `<prefix><kid>` form OR the legacy_username. Operators
--     re-issue creds at their leisure.
--   * Legacy `pk_live_` rows migrate with their existing kid; the new
--     bearer string can only be displayed for credentials minted AFTER
--     this migration (we never stored the plaintext of legacy secrets).
--   * Legacy submission_credentials rows resolve mailbox_id via the
--     principals.mailbox_id back-pointer.
--   * receiver_id is NULL for migrated IMAP rows — operators rebind via
--     the panel/CLI post-migration.
--
-- Audit actions: reuses existing mailbox_credential.{issue,rotate,disable}
-- per packages/schema/src/index.ts:878-880. The `meta` JSON carries a
-- `type` discriminator so historic rows + new rows share one action set.

PRAGMA foreign_keys = OFF;

-- ============================================================================
-- mailbox_credentials_v2 — unified credential table
-- ============================================================================

CREATE TABLE mailbox_credentials_v2 (
  id                 TEXT PRIMARY KEY,            -- ULID; the kid (printed after the prefix)
  mailbox_id         TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  type               TEXT NOT NULL CHECK(type IN ('imap','smtp','rest','mcp','cli')),
  prefix             TEXT NOT NULL CHECK(prefix IN ('pmimap_','pmsmtp_','pmtk_','pmmcp_','pmcli_')),
  secret_hash        TEXT NOT NULL,               -- $2b$… (bcrypt) for imap/smtp, $pbkdf2-sha256$… for rest/mcp/cli
  secret_prev_hash   TEXT,                        -- planned-rotation grace window; nullable
  receiver_id        TEXT REFERENCES mailbox_receivers(id) ON DELETE SET NULL,  -- IMAP-only binding
  display_name       TEXT,
  legacy_username    TEXT,                        -- transition: lookup fallback for pre-v2 MUA configs
  status             TEXT NOT NULL DEFAULT 'primary'
                       CHECK(status IN ('primary','secondary','revoked')),
  rate_limit_per_min INTEGER NOT NULL DEFAULT 60,
  created_at         TEXT NOT NULL,
  last_used_at       TEXT,
  last_used_ip       TEXT,
  disabled_at        TEXT,
  revoked_at         TEXT
);

CREATE INDEX idx_mc2_mailbox
  ON mailbox_credentials_v2(mailbox_id);
CREATE INDEX idx_mc2_type
  ON mailbox_credentials_v2(mailbox_id, type);
CREATE INDEX idx_mc2_receiver
  ON mailbox_credentials_v2(receiver_id);
-- legacy_username is searched by the bridge during the transition
-- window only; once the contract migration lands it gets dropped.
CREATE INDEX idx_mc2_legacy_username
  ON mailbox_credentials_v2(legacy_username);

-- ============================================================================
-- Backfill — IMAP from mailbox_credentials
-- ============================================================================

INSERT INTO mailbox_credentials_v2
  (id, mailbox_id, type, prefix, secret_hash, receiver_id, display_name,
   legacy_username, status, rate_limit_per_min,
   created_at, last_used_at, disabled_at)
SELECT
  id,
  mailbox_id,
  'imap',
  'pmimap_',
  bcrypt_hash,
  NULL,                  -- operators rebind to a receiver post-migration
  username,              -- carry the human-friendly username into display_name
  username,              -- AND keep it as legacy_username for the bridge lookup fallback
  'primary',
  60,
  created_at,
  last_used_at,
  disabled_at
FROM mailbox_credentials
WHERE protocol = 'imap';

-- ============================================================================
-- Backfill — SMTP from mailbox_credentials (the SMTPS bridge auth path)
-- ============================================================================

INSERT INTO mailbox_credentials_v2
  (id, mailbox_id, type, prefix, secret_hash, display_name,
   legacy_username, status, rate_limit_per_min,
   created_at, last_used_at, disabled_at)
SELECT
  id,
  mailbox_id,
  'smtp',
  'pmsmtp_',
  bcrypt_hash,
  username,
  username,
  'primary',
  60,
  created_at,
  last_used_at,
  disabled_at
FROM mailbox_credentials
WHERE protocol = 'smtps';

-- ============================================================================
-- Backfill — SMTP from submission_credentials (sender-bound send-as)
-- ============================================================================
-- The legacy table is sender-bound 1:1; the new model is mailbox-bound
-- (any sender at submit time). We pull the mailbox_id through the
-- principals back-pointer. The legacy sender association is dropped at
-- the row level — bridge MAIL FROM validation now reads
-- mailbox_senders directly.

INSERT INTO mailbox_credentials_v2
  (id, mailbox_id, type, prefix, secret_hash, display_name,
   legacy_username, status, rate_limit_per_min,
   created_at, last_used_at, disabled_at)
SELECT
  sc.id,
  p.mailbox_id,
  'smtp',
  'pmsmtp_',
  sc.bcrypt_hash,
  sc.username,
  sc.username,
  'primary',
  60,
  sc.created_at,
  sc.last_used_at,
  sc.disabled_at
FROM submission_credentials sc
JOIN principals p ON p.id = sc.principal_id
WHERE p.mailbox_id IS NOT NULL;

-- ============================================================================
-- Backfill — REST from api_keys (pk_live_ rows)
-- ============================================================================
-- Existing pk_live_ keys keep working on the legacy HMAC path
-- (X-Polaris-Key-Id + signed body) — the v2 row is the new home of
-- record, but the new Bearer path won't work for these rows because
-- their plaintext was never stored. Operators re-issue to opt in to
-- the Bearer convenience. Sender-scope rows (api_key_sender_scopes)
-- are intentionally dropped from the v2 row: credentials in the new
-- model are mailbox-scoped, and SMTP MAIL FROM validation moves to
-- the bridge layer reading mailbox_senders.

INSERT INTO mailbox_credentials_v2
  (id, mailbox_id, type, prefix, secret_hash, display_name,
   status, rate_limit_per_min,
   created_at, last_used_at, last_used_ip, disabled_at, revoked_at)
SELECT
  ak.id,
  p.mailbox_id,
  'rest',
  'pmtk_',
  ak.secret_argon2id,
  p.display_name,
  ak.status,
  ak.rate_limit_per_min,
  ak.created_at,
  ak.last_used_at,
  ak.last_used_ip,
  ak.disabled_at,
  ak.revoked_at
FROM api_keys ak
JOIN principals p ON p.id = ak.principal_id
WHERE ak.prefix = 'pk_live_'
  AND p.mailbox_id IS NOT NULL;

PRAGMA foreign_keys = ON;

-- ============================================================================
-- Version stamp
-- ============================================================================
INSERT INTO schema_migrations (version, applied_at, sha)
VALUES (2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '0002_unified_credentials');
