-- polaris-email D1 schema v2: outbound domains, senders, SMTP credentials.
-- Append-only migration. Never edit; add 0003_*.sql for changes.
PRAGMA foreign_keys = ON;

-- An "outbound domain" is a domain we send mail FROM (Worker send_email binding,
-- Mox SMTP submission, etc). Separate from `domains` (inbound/verification) so this
-- migration is small and avoids hybrid-state reasoning.
CREATE TABLE IF NOT EXISTS outbound_domains (
  id              TEXT PRIMARY KEY,
  domain          TEXT NOT NULL UNIQUE,
  dkim_selector   TEXT NOT NULL DEFAULT 'cf2024-1',
  status          TEXT NOT NULL CHECK (status IN ('pending','verified','active','disabled')),
  cf_zone_id      TEXT,
  is_default      INTEGER NOT NULL DEFAULT 0,   -- exactly one row SHOULD have is_default=1
  dmarc_policy    TEXT NOT NULL DEFAULT 'none' CHECK (dmarc_policy IN ('none','quarantine','reject')),
  dmarc_rua       TEXT,                          -- optional rua= URI; defaults to postmaster@<domain>
  binding_tag     TEXT,                          -- override for binding name (uppercase tag); else derived
  last_verified_at INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  disabled_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_outbound_domains_status ON outbound_domains(status);

-- A "sender" is a `From:` identity scoped to an outbound domain (noreply@, alerts@, …).
CREATE TABLE IF NOT EXISTS email_senders (
  id                  TEXT PRIMARY KEY,
  domain_id           TEXT NOT NULL REFERENCES outbound_domains(id),
  local_part          TEXT NOT NULL,
  display_name        TEXT,
  default_for_domain  INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  disabled_at         INTEGER,
  UNIQUE(domain_id, local_part)
);
CREATE INDEX IF NOT EXISTS idx_email_senders_domain ON email_senders(domain_id);

-- Many-to-many: which API keys may use which senders. Replaces today's free-form
-- sender_scopes JSON on api_keys (kept for now for back-compat; migrate later).
CREATE TABLE IF NOT EXISTS sender_key_scopes (
  key_id      TEXT NOT NULL REFERENCES api_keys(id),
  sender_id   TEXT NOT NULL REFERENCES email_senders(id),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (key_id, sender_id)
);
CREATE INDEX IF NOT EXISTS idx_sender_key_scopes_sender ON sender_key_scopes(sender_id);

-- SMTP credentials issued for a sender. One sender can have multiple SMTP clients
-- (rotation, multi-app). Hashed at rest using the same primitive as api_keys
-- (services/api/src/hashing.ts `hashSecret`).
CREATE TABLE IF NOT EXISTS smtp_credentials (
  id                TEXT PRIMARY KEY,
  sender_id         TEXT NOT NULL REFERENCES email_senders(id),
  username          TEXT NOT NULL UNIQUE,
  password_argon2id TEXT NOT NULL,
  label             TEXT,
  last_used_at      INTEGER,
  last_used_ip      TEXT,
  disabled_at       INTEGER,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_smtp_credentials_sender ON smtp_credentials(sender_id);
