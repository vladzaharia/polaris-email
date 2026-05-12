-- polaris-email D1 schema v5: pending Mox operations queue.
--
-- Background: a Cloudflare Worker cannot reach the bridge sidecar directly on the
-- Tailnet. Mox's admin API requires PLAINTEXT passwords (SetPassword bcrypts at
-- rest), but the api Worker only persists hashes (smtp_credentials.password_hash).
-- We therefore enqueue plaintext + the desired op here, where the sidecar drains
-- it on each ~5s config-poll tick. Plaintext lives in D1 for at most ~5s
-- (sidecar-acked) and is then scrubbed by the janitor.
--
-- Privacy: payload_b64 holds base64 of plaintext password material. NEVER log it.
-- The janitor + sidecar treat the row as opaque outside of the Mox call itself.
--
-- Append-only migration. Never edit; add 0006_*.sql for further changes.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS mox_pending_ops (
  id          TEXT PRIMARY KEY,            -- ULID, matches existing id style
  op          TEXT NOT NULL CHECK (op IN ('set_password','remove_account')),
  username    TEXT NOT NULL,               -- full address, e.g. noreply@plrs.im
  payload_b64 TEXT,                        -- base64 of plaintext password; NULL for remove_account
  created_at  INTEGER NOT NULL,
  applied_at  INTEGER,                     -- NULL until acked by the sidecar
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT                         -- truncated to ~200 chars on failure
);

CREATE INDEX IF NOT EXISTS idx_mox_pending_ops_unapplied
  ON mox_pending_ops(applied_at, created_at)
  WHERE applied_at IS NULL;
