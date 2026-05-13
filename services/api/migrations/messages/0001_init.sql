-- polaris-messages-YYYY-MM D1 schema v1
-- This is the TEMPLATE schema applied to each per-month messages shard.
-- Append-only migration. Never edit; add 0002_*.sql for changes.
PRAGMA foreign_keys = ON;

-- Custom schema-migrations runner uses this table (see packages/migrations).
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  sha        TEXT NOT NULL
);

-- Messages. tenant_id is denormalized (no FK across DBs).
-- to_hash_pending=1 means deferred Argon2id derivation hasn't yet filled
-- to_hash_ciphertext (mitigation I5 in the design plan).
CREATE TABLE IF NOT EXISTS messages (
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
CREATE INDEX IF NOT EXISTS idx_messages_tenant_id ON messages(tenant_id);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
CREATE INDEX IF NOT EXISTS idx_messages_content_sha256 ON messages(content_sha256);
CREATE INDEX IF NOT EXISTS idx_messages_idempotency_key ON messages(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_messages_environment ON messages(environment);
CREATE INDEX IF NOT EXISTS idx_messages_to_hash_pending ON messages(to_hash_pending);

-- Per-attempt records for outbound retries.
CREATE TABLE IF NOT EXISTS message_attempts (
  id               TEXT PRIMARY KEY,
  message_id       TEXT NOT NULL REFERENCES messages(id),
  send_attempt_id  TEXT,
  attempted_at     TEXT NOT NULL,
  succeeded        INTEGER NOT NULL,
  error            TEXT
);
CREATE INDEX IF NOT EXISTS idx_message_attempts_message_id ON message_attempts(message_id);

-- Idempotency-Key dedupe (mitigation I2). Per (tenant, key); enforced at the
-- key column with tenant_id as a stored discriminator. Callers must namespace
-- by tenant on insert.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  principal_id  TEXT,
  message_id    TEXT NOT NULL REFERENCES messages(id),
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_tenant_id ON idempotency_keys(tenant_id);
