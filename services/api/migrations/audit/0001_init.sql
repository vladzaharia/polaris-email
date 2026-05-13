-- polaris-audit D1 schema v1
-- Append-only migration. Never edit; add 0002_*.sql for changes.
-- Hash-chained audit log + signed anchor records (tamper-evidence).
PRAGMA foreign_keys = ON;

-- Custom schema-migrations runner uses this table (see packages/migrations).
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  sha        TEXT NOT NULL
);

-- Append-only audit log. Same shape as the legacy audit_log table; row_hash
-- chains via prev_hash. Genesis row has prev_hash = '0'*64.
CREATE TABLE IF NOT EXISTS audit_log (
  id           TEXT PRIMARY KEY,
  ts           TEXT NOT NULL,
  actor        TEXT,
  action       TEXT NOT NULL,
  resource     TEXT NOT NULL,
  resource_id  TEXT,
  prev_hash    TEXT,
  row_hash     TEXT NOT NULL,
  payload      TEXT,
  environment  TEXT NOT NULL DEFAULT 'prod'
);
CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_resource ON audit_log(resource);
CREATE INDEX IF NOT EXISTS idx_audit_log_environment ON audit_log(environment);

-- Signed checkpoints over a prefix of the audit_log chain. anchor_object_key
-- references an R2 object (immutable copy of the signed bundle).
CREATE TABLE IF NOT EXISTS audit_anchors (
  id                 TEXT PRIMARY KEY,
  audit_log_id       TEXT NOT NULL REFERENCES audit_log(id),
  signed_at          TEXT NOT NULL,
  signature          TEXT NOT NULL,
  anchor_object_key  TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_anchors_audit_log_id ON audit_anchors(audit_log_id);
