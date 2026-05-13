-- polaris-email v1 canonical schema. Single D1 (`polaris-email`).
--
-- This is the from-scratch v1 schema; nothing was deployed prior to it.
-- Earlier migrations (0001..0006 in previous revisions of this branch)
-- have been collapsed into this single file.
--
-- Append-only going forward; add 0002_*.sql etc. for any future change.

PRAGMA foreign_keys = ON;

-- ---- Bookkeeping ---------------------------------------------------------

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  sha        TEXT NOT NULL
);

-- One-shot bootstrap: holds the first admin key + WebAuthn enrollment
-- evidence. id is a sentinel constant so there can only ever be one row.
CREATE TABLE bootstrap (
  id                       INTEGER PRIMARY KEY CHECK(id = 1),
  consumed_at              TEXT,
  admin_key_id             TEXT,
  admin_key_secret         TEXT,
  webauthn_credential_id   TEXT
);
INSERT INTO bootstrap (id) VALUES (1);

-- ---- Tenancy + control plane ---------------------------------------------

CREATE TABLE tenants (
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
CREATE INDEX idx_tenants_environment ON tenants(environment);

CREATE TABLE zones (
  id          TEXT PRIMARY KEY,
  cf_zone_id  TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL
);

-- mail_domains. wildcard_subdomains=1 (default) means CF auto-publishes
-- wildcard DKIM and our routing covers *@*.<domain> implicitly. The
-- canonical EMAIL binding is account-level; binding_tag is kept only as
-- an opt-in override for operators that want a per-domain binding.
CREATE TABLE mail_domains (
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
  cf_zone_id           TEXT,
  dkim_selector        TEXT DEFAULT 'cf',
  binding_tag          TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  verified_at          TEXT,
  last_verify_check_at TEXT,
  disabled_at          TEXT
);
CREATE INDEX idx_mail_domains_zone_id ON mail_domains(zone_id);
CREATE INDEX idx_mail_domains_parent ON mail_domains(parent_domain_id);
CREATE INDEX idx_mail_domains_environment ON mail_domains(environment);
CREATE INDEX idx_mail_domains_status ON mail_domains(status);

CREATE TABLE email_senders (
  id                  TEXT PRIMARY KEY,
  domain_id           TEXT NOT NULL REFERENCES mail_domains(id),
  address             TEXT NOT NULL UNIQUE,
  local_part          TEXT,
  display_name        TEXT,
  environment         TEXT NOT NULL DEFAULT 'prod',
  default_for_domain  INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  disabled_at         TEXT
);
CREATE INDEX idx_email_senders_domain_id ON email_senders(domain_id);
CREATE INDEX idx_email_senders_environment ON email_senders(environment);

-- ---- Principals + credentials --------------------------------------------

CREATE TABLE principals (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  kind          TEXT NOT NULL CHECK(kind IN ('api_key','smtp_cred')),
  display_name  TEXT,
  environment   TEXT NOT NULL DEFAULT 'prod',
  created_at    TEXT NOT NULL,
  disabled_at   TEXT
);
CREATE INDEX idx_principals_tenant_id ON principals(tenant_id);
CREATE INDEX idx_principals_environment ON principals(environment);
CREATE INDEX idx_principals_kind ON principals(kind);

CREATE TABLE api_keys (
  id                  TEXT PRIMARY KEY,
  principal_id        TEXT NOT NULL REFERENCES principals(id),
  prefix              TEXT NOT NULL,
  secret_argon2id     TEXT NOT NULL,
  scopes              TEXT NOT NULL,
  sender_scopes       TEXT,
  rate_limit_per_min  INTEGER NOT NULL DEFAULT 60,
  status              TEXT NOT NULL DEFAULT 'primary' CHECK(status IN ('primary','secondary','revoked')),
  created_at          TEXT NOT NULL,
  last_used_at        TEXT,
  last_used_ip        TEXT,
  last_used_ua        TEXT,
  revoked_at          TEXT,
  disabled_at         TEXT
);
CREATE INDEX idx_api_keys_principal_id ON api_keys(principal_id);
CREATE INDEX idx_api_keys_status ON api_keys(status);

CREATE TABLE submission_credentials (
  id            TEXT PRIMARY KEY,
  principal_id  TEXT NOT NULL REFERENCES principals(id),
  daemon_id     TEXT,
  username      TEXT NOT NULL UNIQUE,
  bcrypt_hash   TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT,
  disabled_at   TEXT
);
CREATE INDEX idx_submission_credentials_principal_id ON submission_credentials(principal_id);
CREATE INDEX idx_submission_credentials_daemon_id ON submission_credentials(daemon_id);

CREATE TABLE principal_sender_scopes (
  principal_id  TEXT NOT NULL REFERENCES principals(id),
  sender_id     TEXT NOT NULL REFERENCES email_senders(id),
  created_at    TEXT NOT NULL,
  PRIMARY KEY (principal_id, sender_id)
);
CREATE INDEX idx_principal_sender_scopes_sender ON principal_sender_scopes(sender_id);

-- ---- DKIM key rotation ---------------------------------------------------

CREATE TABLE dkim_keys (
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
CREATE INDEX idx_dkim_keys_domain_id ON dkim_keys(domain_id);
CREATE INDEX idx_dkim_keys_state ON dkim_keys(state);

-- ---- Submission daemons --------------------------------------------------

CREATE TABLE daemons (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL UNIQUE,
  environment           TEXT NOT NULL DEFAULT 'prod',
  hmac_key_secret_name  TEXT,
  access_token_id       TEXT,
  last_seen_at          TEXT,
  created_at            TEXT NOT NULL,
  disabled_at           TEXT
);
CREATE INDEX idx_daemons_environment ON daemons(environment);

-- ---- Webhook subscriptions + inbound routing -----------------------------

CREATE TABLE webhook_subs (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  domain_id    TEXT REFERENCES mail_domains(id),
  route_id     TEXT,
  url          TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'external' CHECK(kind IN ('external','tailnet')),
  secret       TEXT NOT NULL,
  secret_prev  TEXT,
  events       TEXT NOT NULL,
  paused_at    TEXT,
  environment  TEXT NOT NULL DEFAULT 'prod',
  created_at   TEXT NOT NULL,
  disabled_at  TEXT
);
CREATE INDEX idx_webhook_subs_tenant_id ON webhook_subs(tenant_id);
CREATE INDEX idx_webhook_subs_domain_id ON webhook_subs(domain_id);
CREATE INDEX idx_webhook_subs_environment ON webhook_subs(environment);

CREATE TABLE routing_rules (
  id               TEXT PRIMARY KEY,
  domain_id        TEXT NOT NULL REFERENCES mail_domains(id),
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
CREATE INDEX idx_routing_rules_domain_id ON routing_rules(domain_id);
CREATE INDEX idx_routing_rules_environment ON routing_rules(environment);
CREATE INDEX idx_routing_rules_webhook_sub_id ON routing_rules(webhook_sub_id);

-- ---- Messages + delivery tracking ----------------------------------------

CREATE TABLE messages (
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
CREATE INDEX idx_messages_tenant_id ON messages(tenant_id);
CREATE INDEX idx_messages_status ON messages(status);
CREATE INDEX idx_messages_content_sha256 ON messages(content_sha256);
CREATE INDEX idx_messages_idempotency_key ON messages(idempotency_key);
CREATE INDEX idx_messages_environment ON messages(environment);
CREATE INDEX idx_messages_to_hash_pending ON messages(to_hash_pending);

CREATE TABLE message_attempts (
  id               TEXT PRIMARY KEY,
  message_id       TEXT NOT NULL REFERENCES messages(id),
  send_attempt_id  TEXT,
  attempted_at     TEXT NOT NULL,
  succeeded        INTEGER NOT NULL,
  error            TEXT
);
CREATE INDEX idx_message_attempts_message_id ON message_attempts(message_id);

CREATE TABLE message_deliveries (
  message_id          TEXT NOT NULL REFERENCES messages(id),
  webhook_sub_id      TEXT NOT NULL REFERENCES webhook_subs(id),
  status              TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed','dlq')),
  attempts            INTEGER NOT NULL DEFAULT 0,
  next_attempt_at     TEXT,
  last_error          TEXT,
  last_response_code  INTEGER,
  created_at          TEXT NOT NULL,
  PRIMARY KEY (message_id, webhook_sub_id)
);
CREATE INDEX idx_message_deliveries_status ON message_deliveries(status);

CREATE TABLE idempotency_keys (
  key           TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  principal_id  TEXT,
  message_id    TEXT REFERENCES messages(id),
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_idempotency_keys_tenant_id ON idempotency_keys(tenant_id);

-- ---- Audit chain ---------------------------------------------------------

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  meta       TEXT NOT NULL,
  at         INTEGER NOT NULL,
  prev_hash  TEXT NOT NULL,
  row_hash   TEXT NOT NULL
);
CREATE INDEX idx_audit_log_at ON audit_log(at);
CREATE INDEX idx_audit_log_action ON audit_log(action);
CREATE INDEX idx_audit_log_actor ON audit_log(actor);

CREATE TABLE audit_anchors (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  last_audit_id      INTEGER NOT NULL,
  signed_at          TEXT NOT NULL,
  signature          TEXT NOT NULL,
  anchor_object_key  TEXT
);
