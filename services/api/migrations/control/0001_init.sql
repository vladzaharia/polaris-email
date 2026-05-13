-- polaris-control D1 schema v1
-- Append-only migration. Never edit; add 0002_*.sql for changes.
-- This database holds tenant/zone/domain/principal control-plane data.
PRAGMA foreign_keys = ON;

-- Custom schema-migrations runner uses this table (see packages/migrations).
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  sha        TEXT NOT NULL
);

-- Tenants (formerly "services" in legacy schema). One per logical customer.
-- to_hash_pepper_id references a Workers Secret name (HKDF-derived); never
-- store the pepper material itself in D1.
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

-- Cloudflare zones. A zone may host multiple domains (apex + subdomains).
CREATE TABLE IF NOT EXISTS zones (
  id          TEXT PRIMARY KEY,
  cf_zone_id  TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL
);

-- Domains. Linked to a zone; may have a parent domain (for nested wildcard
-- subdomains). DKIM selectors live in dkim_keys (multi-key rotation).
-- The Workers EMAIL binding is account-level, so no per-domain binding_tag.
CREATE TABLE IF NOT EXISTS domains (
  id                   TEXT PRIMARY KEY,
  zone_id              TEXT NOT NULL REFERENCES zones(id),
  parent_domain_id     TEXT REFERENCES domains(id),
  name                 TEXT NOT NULL UNIQUE,
  environment          TEXT NOT NULL DEFAULT 'prod',
  status               TEXT NOT NULL DEFAULT 'pending',
  wildcard_subdomains  INTEGER NOT NULL DEFAULT 1,
  dmarc_policy         TEXT,
  dmarc_rua            TEXT,
  inbound_enabled      INTEGER NOT NULL DEFAULT 0,
  outbound_enabled     INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  disabled_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_domains_zone_id ON domains(zone_id);
CREATE INDEX IF NOT EXISTS idx_domains_parent_domain_id ON domains(parent_domain_id);
CREATE INDEX IF NOT EXISTS idx_domains_environment ON domains(environment);

-- Email senders. `address` is the full email; routing lookup is
-- suffix-match against domains.name (most-specific-wins) handled in code.
CREATE TABLE IF NOT EXISTS email_senders (
  id                  TEXT PRIMARY KEY,
  domain_id           TEXT NOT NULL REFERENCES domains(id),
  address             TEXT NOT NULL UNIQUE,
  local_part          TEXT,
  environment         TEXT NOT NULL DEFAULT 'prod',
  default_for_domain  INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  disabled_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_senders_domain_id ON email_senders(domain_id);
CREATE INDEX IF NOT EXISTS idx_email_senders_environment ON email_senders(environment);

-- Principals: an authenticatable identity. Either an HMAC API key or a
-- SMTP submission credential (1:1 with a daemon).
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

-- API keys. One row per principal of kind='api_key'.
-- scopes is a JSON-encoded array of scope strings.
CREATE TABLE IF NOT EXISTS api_keys (
  id            TEXT PRIMARY KEY,
  principal_id  TEXT NOT NULL REFERENCES principals(id),
  hash          TEXT NOT NULL,
  hash_alg      TEXT NOT NULL,
  scopes        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT,
  disabled_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_keys_principal_id ON api_keys(principal_id);

-- SMTP submission credentials. One row per principal of kind='smtp_cred'.
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

-- Many-to-many: which senders may a principal send AS.
CREATE TABLE IF NOT EXISTS principal_sender_scopes (
  principal_id  TEXT NOT NULL REFERENCES principals(id),
  sender_id     TEXT NOT NULL REFERENCES email_senders(id),
  created_at    TEXT NOT NULL,
  PRIMARY KEY (principal_id, sender_id)
);
CREATE INDEX IF NOT EXISTS idx_principal_sender_scopes_sender ON principal_sender_scopes(sender_id);

-- Webhook subscriptions. Routing is by (tenant, optional domain, optional
-- routing_rule). prev_secret enables zero-downtime rotation.
CREATE TABLE IF NOT EXISTS webhook_subs (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  domain_id    TEXT REFERENCES domains(id),
  route_id     TEXT,
  target_url   TEXT NOT NULL,
  secret       TEXT NOT NULL,
  prev_secret  TEXT,
  paused_at    TEXT,
  environment  TEXT NOT NULL DEFAULT 'prod',
  created_at   TEXT NOT NULL,
  disabled_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_webhook_subs_tenant_id ON webhook_subs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_webhook_subs_domain_id ON webhook_subs(domain_id);
CREATE INDEX IF NOT EXISTS idx_webhook_subs_environment ON webhook_subs(environment);

-- Routing rules. address_pattern is IDNA-normalized exact match;
-- suffix-matching across the domain hierarchy is handled in code.
CREATE TABLE IF NOT EXISTS routing_rules (
  id               TEXT PRIMARY KEY,
  domain_id        TEXT NOT NULL REFERENCES domains(id),
  priority         INTEGER NOT NULL DEFAULT 100,
  address_pattern  TEXT NOT NULL,
  action           TEXT NOT NULL CHECK(action IN ('webhook','forward','drop','alias')),
  webhook_sub_id   TEXT REFERENCES webhook_subs(id),
  forward_to       TEXT,
  environment      TEXT NOT NULL DEFAULT 'prod',
  enabled          INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  disabled_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_routing_rules_domain_id ON routing_rules(domain_id);
CREATE INDEX IF NOT EXISTS idx_routing_rules_environment ON routing_rules(environment);
CREATE INDEX IF NOT EXISTS idx_routing_rules_webhook_sub_id ON routing_rules(webhook_sub_id);
