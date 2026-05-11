-- polaris-email D1 schema v1
-- Append-only migration. Never edit; add 0002_*.sql for changes.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS services (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  owner        TEXT,
  notes        TEXT,
  to_hash_pepper TEXT NOT NULL,   -- per-tenant pepper for HMAC of recipient lists
  created_at   INTEGER NOT NULL,
  disabled_at  INTEGER
);

CREATE TABLE IF NOT EXISTS domains (
  name                  TEXT PRIMARY KEY,
  direction             TEXT NOT NULL CHECK (direction IN ('in','out','both')),
  binding_name          TEXT,
  dns_records_json      TEXT,
  verified_at           INTEGER,
  last_verify_check_at  INTEGER,
  disabled_at           INTEGER
);

CREATE TABLE IF NOT EXISTS mailboxes (
  id                  TEXT PRIMARY KEY,
  address             TEXT NOT NULL UNIQUE,
  display_name        TEXT,
  service_id          TEXT REFERENCES services(id),
  imap_username       TEXT UNIQUE,
  imap_pw_bcrypt      TEXT,
  imap_pw_bcrypt_prev TEXT,
  imap_pw_rotated_at  INTEGER,
  retain_imap         INTEGER NOT NULL DEFAULT 0,
  retention_days      INTEGER NOT NULL DEFAULT 90,
  max_inbound_bytes   INTEGER NOT NULL DEFAULT 26214400, -- 25 MiB
  created_at          INTEGER NOT NULL,
  disabled_at         INTEGER
);

CREATE TABLE IF NOT EXISTS api_keys (
  id                  TEXT PRIMARY KEY,
  prefix              TEXT NOT NULL,
  secret_argon2id     TEXT NOT NULL,
  service_id          TEXT REFERENCES services(id),
  sender_scopes       TEXT NOT NULL,  -- JSON array of SenderScope
  scopes              TEXT NOT NULL DEFAULT '["send"]', -- JSON array of KeyScope
  rate_limit_per_min  INTEGER NOT NULL DEFAULT 1000,
  status              TEXT NOT NULL CHECK (status IN ('primary','secondary','revoked')),
  created_at          INTEGER NOT NULL,
  revoked_at          INTEGER,
  last_used_at        INTEGER,
  last_used_ip        TEXT,
  last_used_ua        TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_keys_service ON api_keys(service_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_status ON api_keys(status, revoked_at);

CREATE TABLE IF NOT EXISTS local_webhook_targets (
  id          TEXT PRIMARY KEY,
  service_id  TEXT REFERENCES services(id),
  service     TEXT NOT NULL,
  rule        TEXT NOT NULL,
  upstream    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  disabled_at INTEGER,
  UNIQUE(service, rule)
);

CREATE TABLE IF NOT EXISTS webhook_subs (
  id              TEXT PRIMARY KEY,
  mailbox_id      TEXT REFERENCES mailboxes(id),
  service_id      TEXT REFERENCES services(id),
  url             TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('external','tailnet','bridge')),
  local_target_id TEXT REFERENCES local_webhook_targets(id),
  secret          TEXT NOT NULL,
  secret_prev     TEXT,
  secret_prev_expires_at INTEGER,
  events          TEXT NOT NULL,
  paused_at       INTEGER,
  CHECK (
    (kind = 'bridge'  AND local_target_id IS NOT NULL) OR
    (kind <> 'bridge' AND local_target_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_webhook_subs_mailbox ON webhook_subs(mailbox_id);

CREATE TABLE IF NOT EXISTS routing_rules (
  id         TEXT PRIMARY KEY,
  domain     TEXT NOT NULL,
  match_json TEXT NOT NULL,
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id),
  priority   INTEGER NOT NULL DEFAULT 100,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_routing_rules_domain ON routing_rules(domain, priority);

CREATE TABLE IF NOT EXISTS messages (
  id                     TEXT PRIMARY KEY,
  mailbox_id             TEXT REFERENCES mailboxes(id),
  service_id             TEXT REFERENCES services(id),
  direction              TEXT NOT NULL CHECK (direction IN ('in','out')),
  mode                   TEXT NOT NULL DEFAULT 'live' CHECK (mode IN ('live','test')),
  status                 TEXT,
  from_addr              TEXT,
  to_hash                TEXT,
  to_forensic_encrypted  TEXT,
  to_forensic_key_version INTEGER,
  subject                TEXT,
  size_bytes             INTEGER NOT NULL DEFAULT 0,
  r2_key                 TEXT,
  category               TEXT,
  idempotency_key        TEXT,
  imap_uid               INTEGER,
  imap_uidvalidity       INTEGER,
  delivered_to_imap_at   INTEGER,
  last_error             TEXT,
  smtp_response          TEXT,
  auth_results_json      TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_mbox_time ON messages(mailbox_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_pending_imap
  ON messages(mailbox_id, delivered_to_imap_at)
  WHERE direction='in' AND delivered_to_imap_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_messages_idempotency
  ON messages(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_service_status_time
  ON messages(service_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS message_deliveries (
  message_id          TEXT NOT NULL,
  sub_id              TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('pending','succeeded','failed','dlq')),
  attempts            INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT,
  last_response_code  INTEGER,
  next_attempt_at     INTEGER,
  succeeded_at        INTEGER,
  failed_at           INTEGER,
  PRIMARY KEY (message_id, sub_id)
);
CREATE INDEX IF NOT EXISTS idx_deliveries_due
  ON message_deliveries(status, next_attempt_at)
  WHERE status='pending';
CREATE INDEX IF NOT EXISTS idx_deliveries_sub
  ON message_deliveries(sub_id, status);

CREATE TABLE IF NOT EXISTS api_key_usage (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id       TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  ip           TEXT,
  user_agent   TEXT,
  cf_ray       TEXT,
  request_id   TEXT,
  route        TEXT,
  result_code  TEXT
);
CREATE INDEX IF NOT EXISTS idx_key_usage_key_ts ON api_key_usage(key_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_key_usage_ts ON api_key_usage(ts DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  meta_json  TEXT NOT NULL DEFAULT '{}',
  prev_hash  TEXT NOT NULL,
  row_hash   TEXT NOT NULL,
  at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action_at ON audit_log(action, at DESC);

-- Sentinel row guarantees a stable hash-chain start.
INSERT OR IGNORE INTO audit_log (id, actor, action, target, meta_json, prev_hash, row_hash, at)
VALUES (
  0,
  'system',
  'schema.migration',
  '0001_init',
  '{"genesis":true}',
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000000',
  0
);

CREATE TABLE IF NOT EXISTS audit_anchors (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  last_audit_id   INTEGER NOT NULL,
  last_row_hash   TEXT NOT NULL,
  signature       TEXT NOT NULL,
  signed_at       INTEGER NOT NULL,
  external_ref    TEXT
);

CREATE TABLE IF NOT EXISTS bootstrap (
  id                     INTEGER PRIMARY KEY CHECK (id = 1),
  seeded_at              INTEGER NOT NULL,
  consumed_at            INTEGER,
  webauthn_credential_id TEXT,
  pending_secret_hash    TEXT,
  pending_key_id         TEXT
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  sha256     TEXT NOT NULL
);
