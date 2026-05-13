-- polaris-control D1 schema v2: DKIM keys + daemons.
-- Append-only migration. Never edit; add 0003_*.sql for changes.
PRAGMA foreign_keys = ON;

-- DKIM keys per domain. Multiple selectors per domain support rotation:
--   pending  -> not yet active (DNS published, awaiting verification)
--   active   -> currently used for signing
--   retiring -> still verifiable but no longer used for new signatures
CREATE TABLE IF NOT EXISTS dkim_keys (
  id            TEXT PRIMARY KEY,
  domain_id     TEXT NOT NULL REFERENCES domains(id),
  selector      TEXT NOT NULL,
  public_key    TEXT NOT NULL,
  algo          TEXT NOT NULL CHECK(algo IN ('ed25519','rsa2048')),
  state         TEXT NOT NULL CHECK(state IN ('pending','active','retiring')),
  activated_at  TEXT,
  retired_at    TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE(domain_id, selector)
);
CREATE INDEX IF NOT EXISTS idx_dkim_keys_domain_id ON dkim_keys(domain_id);
CREATE INDEX IF NOT EXISTS idx_dkim_keys_state ON dkim_keys(state);

-- Daemons: SMTP-submission bridges (e.g. Mox sidecar nodes).
-- hmac_key_secret_name references a Workers Secret holding the daemon's
-- HMAC key material. access_token_id references a Tailscale OAuth token.
CREATE TABLE IF NOT EXISTS daemons (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL UNIQUE,
  environment           TEXT NOT NULL DEFAULT 'prod',
  hmac_key_secret_name  TEXT,
  access_token_id       TEXT,
  last_seen_at          TEXT,
  created_at            TEXT NOT NULL,
  disabled_at           TEXT
);
CREATE INDEX IF NOT EXISTS idx_daemons_environment ON daemons(environment);
