-- polaris-email — composite primary key on idempotency_keys (schema version=4)
--
-- A8 (cleanup plan): the previous schema used `key` as a global PRIMARY KEY,
-- which allowed cross-principal collisions. Two principals submitting the
-- same Idempotency-Key string would race for a single row, and the loser
-- would observe the winner's `message_id` — a cross-tenant data leak.
--
-- Hard cutover. Existing rows are dropped; the 24h KV idempotency window
-- absorbs in-flight callers (they retry cleanly against the new schema).
-- See cleanup plan A8.
--
-- Columns and types mirror the original 0001_init.sql definition. The only
-- substantive change is the PRIMARY KEY: now `(principal_id, key)` rather
-- than `key` alone. principal_id is promoted to NOT NULL because SQLite
-- requires every column of a composite PRIMARY KEY to be NOT NULL, and
-- every code path that writes idempotency_keys (services/api + pipeline)
-- already supplies a non-null principal_id for outbound submissions —
-- inbound traffic does not use this table.

DROP TABLE IF EXISTS idempotency_keys;

CREATE TABLE idempotency_keys (
  principal_id TEXT NOT NULL,
  key          TEXT NOT NULL,
  mailbox_id   TEXT NOT NULL REFERENCES mailboxes(id),
  message_id   TEXT REFERENCES messages(id),
  expires_at   TEXT,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (principal_id, key)
);
CREATE INDEX idx_idempotency_keys_expires_at ON idempotency_keys (expires_at);
