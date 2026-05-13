-- Phase 0 consolidated migration. Single D1 (the sharded design was
-- rolled back per operator decision: at our expected volume, splitting D1
-- by purpose adds operational complexity without commensurate benefit).
--
-- This migration:
--   1. Drops Mox-era tables (mailboxes, mox_pending_ops, local_webhook_targets,
--      api_key_usage) which no longer have any consumers after admin.ts
--      cleanup. The polaris-email submission daemon owns its own credential
--      mirror; per-message API key usage is captured by Workers Analytics
--      Engine instead.
--   2. Adds the new tables for the v2 design (tenants, zones, principals,
--      principal_sender_scopes, dkim_keys, daemons, idempotency_keys,
--      message_attempts, submission_credentials) WITHOUT touching the legacy
--      'services'/'outbound_domains'/'email_senders'/'smtp_credentials'/
--      'sender_key_scopes'/'api_keys'/'webhook_subs'/'routing_rules'/'messages'
--      tables. The new code paths use the new tables; legacy admin routes
--      continue to use the legacy tables until the cutover migration in 0007.
--
-- Append-only. Never edit; add 0007_*.sql for future changes.

PRAGMA foreign_keys = OFF;

-- 1. Drop tables with no remaining consumers --------------------------------

DROP TABLE IF EXISTS mailboxes;
DROP TABLE IF EXISTS mox_pending_ops;
DROP TABLE IF EXISTS local_webhook_targets;
-- api_key_usage is replaced by Workers Analytics Engine writes via
-- @polaris-email/observability. Per-row usage tracking in D1 was a hot-path
-- write storm at any meaningful traffic.
DROP TABLE IF EXISTS api_key_usage;

-- 2. New control-plane tables ----------------------------------------------

-- Tenants. Replaces the legacy 'services' table. The cutover migration in
-- 0007 will copy services -> tenants and drop services.
CREATE TABLE IF NOT EXISTS tenants (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  description        TEXT,
  environment        TEXT NOT NULL DEFAULT 'prod',
  to_hash_pepper_id  TEXT,
  pepper_version     INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  disabled_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_tenants_environment ON tenants(environment);

-- Zones aggregate. A zone may host multiple domains (apex + subdomains).
CREATE TABLE IF NOT EXISTS zones (
  id          TEXT PRIMARY KEY,
  cf_zone_id  TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL
);

-- mail_domains. Renamed from the planned 'domains' to avoid colliding with
-- the legacy 'domains' table (which is a different shape, used by the
-- legacy inbound DNS verification flow). The cutover migration in 0007 will
-- DROP legacy domains and RENAME mail_domains -> domains. The
-- 'wildcard_subdomains' default true matches the operator-clarified
-- behavior (Cloudflare publishes wildcard records on enable).
CREATE TABLE IF NOT EXISTS mail_domains (
  id                   TEXT PRIMARY KEY,
  zone_id              TEXT NOT NULL REFERENCES zones(id),
  parent_domain_id     TEXT REFERENCES mail_domains(id),
  name                 TEXT NOT NULL UNIQUE,
  environment          TEXT NOT NULL DEFAULT 'prod',
  status               TEXT NOT NULL DEFAULT 'pending',
  wildcard_subdomains  INTEGER NOT NULL DEFAULT 1,
  dmarc_policy         TEXT,
  dmarc_rua            TEXT,
  inbound_enabled      INTEGER NOT NULL DEFAULT 0,
  outbound_enabled     INTEGER NOT NULL DEFAULT 0,
  provider             TEXT NOT NULL DEFAULT 'cloudflare',
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  disabled_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_mail_domains_zone_id ON mail_domains(zone_id);
CREATE INDEX IF NOT EXISTS idx_mail_domains_parent ON mail_domains(parent_domain_id);
CREATE INDEX IF NOT EXISTS idx_mail_domains_environment ON mail_domains(environment);

-- Principals: a uniform credential abstraction (api_key | smtp_cred).
-- The cutover migration will copy legacy api_keys + smtp_credentials into
-- principals + api_keys_v2 + submission_credentials.
CREATE TABLE IF NOT EXISTS principals (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  kind          TEXT NOT NULL CHECK(kind IN ('api_key','smtp_cred')),
  display_name  TEXT,
  environment   TEXT NOT NULL DEFAULT 'prod',
  created_at    TEXT NOT NULL,
  disabled_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_principals_tenant_id ON principals(tenant_id);
CREATE INDEX IF NOT EXISTS idx_principals_environment ON principals(environment);

-- email_senders_v2 — full-address rows under a domain (most-specific-wins
-- resolution at lookup time). Renamed to avoid colliding with legacy
-- email_senders (different shape).
CREATE TABLE IF NOT EXISTS email_senders_v2 (
  id                  TEXT PRIMARY KEY,
  domain_id           TEXT NOT NULL REFERENCES mail_domains(id),
  address             TEXT NOT NULL UNIQUE,
  local_part          TEXT,
  environment         TEXT NOT NULL DEFAULT 'prod',
  default_for_domain  INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  disabled_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_senders_v2_domain_id ON email_senders_v2(domain_id);
CREATE INDEX IF NOT EXISTS idx_email_senders_v2_environment ON email_senders_v2(environment);

-- principal_sender_scopes — single join table for both API key and SMTP
-- credential scoping. Replaces sender_key_scopes + the JSON column on
-- submission_credentials per the architecture audit (A4).
CREATE TABLE IF NOT EXISTS principal_sender_scopes (
  principal_id  TEXT NOT NULL REFERENCES principals(id),
  sender_id     TEXT NOT NULL REFERENCES email_senders_v2(id),
  created_at    TEXT NOT NULL,
  PRIMARY KEY (principal_id, sender_id)
);
CREATE INDEX IF NOT EXISTS idx_principal_sender_scopes_sender ON principal_sender_scopes(sender_id);

-- SMTP submission credentials, owned by a principal.
CREATE TABLE IF NOT EXISTS submission_credentials (
  id            TEXT PRIMARY KEY,
  principal_id  TEXT NOT NULL REFERENCES principals(id),
  daemon_id     TEXT,
  username      TEXT NOT NULL UNIQUE,
  bcrypt_hash   TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT,
  disabled_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_submission_credentials_principal_id ON submission_credentials(principal_id);
CREATE INDEX IF NOT EXISTS idx_submission_credentials_daemon_id ON submission_credentials(daemon_id);

-- DKIM keys per domain. Multiple selectors per domain support rotation:
--   pending  -> not yet active (DNS published, awaiting verification)
--   active   -> currently used for signing
--   retiring -> still verifiable but no longer used for new signatures
CREATE TABLE IF NOT EXISTS dkim_keys (
  id            TEXT PRIMARY KEY,
  domain_id     TEXT NOT NULL REFERENCES mail_domains(id),
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

-- Daemons: SMTP-submission bridges (polaris-daemon hosts).
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

-- 3. New message-tracking tables -------------------------------------------

-- messages_v2. Renamed to avoid colliding with legacy messages. Carries
-- the state machine columns + idempotency-key + content_sha256 per the
-- architecture audit (A7) and the deferred-Argon2id flag (I5).
CREATE TABLE IF NOT EXISTS messages_v2 (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL,
  principal_id         TEXT,
  daemon_id            TEXT,
  submission_id        TEXT,
  direction            TEXT NOT NULL CHECK(direction IN ('in','out')),
  status               TEXT NOT NULL CHECK(status IN ('received','mime_stored','queued','sending','sent','failed','bounced')),
  send_attempt_id      TEXT,
  from_addr            TEXT,
  to_hash_ciphertext   BLOB,
  to_hash_pending      INTEGER NOT NULL DEFAULT 1,
  subject              TEXT,
  r2_key               TEXT NOT NULL,
  content_sha256       TEXT,
  idempotency_key      TEXT,
  environment          TEXT NOT NULL DEFAULT 'prod',
  received_at_daemon   TEXT,
  received_at_api      TEXT,
  queued_at            TEXT,
  sending_at           TEXT,
  sent_at              TEXT,
  failed_at            TEXT,
  bounce_metadata      TEXT,
  last_error           TEXT,
  created_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_v2_tenant_id ON messages_v2(tenant_id);
CREATE INDEX IF NOT EXISTS idx_messages_v2_status ON messages_v2(status);
CREATE INDEX IF NOT EXISTS idx_messages_v2_content_sha256 ON messages_v2(content_sha256);
CREATE INDEX IF NOT EXISTS idx_messages_v2_idempotency_key ON messages_v2(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_messages_v2_environment ON messages_v2(environment);
CREATE INDEX IF NOT EXISTS idx_messages_v2_to_hash_pending ON messages_v2(to_hash_pending);

-- Per-attempt records for outbound retries.
CREATE TABLE IF NOT EXISTS message_attempts (
  id               TEXT PRIMARY KEY,
  message_id       TEXT NOT NULL REFERENCES messages_v2(id),
  send_attempt_id  TEXT,
  attempted_at     TEXT NOT NULL,
  succeeded        INTEGER NOT NULL,
  error            TEXT
);
CREATE INDEX IF NOT EXISTS idx_message_attempts_message_id ON message_attempts(message_id);

-- Idempotency claims (I2 mitigation). D1 is single-region serializable;
-- INSERT OR IGNORE on the primary key gives us atomic claim semantics.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  principal_id  TEXT,
  message_id    TEXT REFERENCES messages_v2(id),
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_tenant_id ON idempotency_keys(tenant_id);

PRAGMA foreign_keys = ON;
