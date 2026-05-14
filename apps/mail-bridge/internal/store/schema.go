// Package store is the bridge-local SQLite mirror of polaris mailbox state.
//
// Latency motivation (per plan section L.9): D1 round-trips from regions
// distant from the API origin are 150–300ms — unacceptable for an
// interactive mail client. The bridge keeps a local SQLite mirror so that
// FETCH/STATUS/SELECT can resolve metadata without crossing the WAN.
//
// Implementation uses `modernc.org/sqlite` (pure-Go, no CGO) so the bridge
// stays statically linkable.
package store

// Schema is the migration applied on Open. Idempotent — every CREATE uses
// IF NOT EXISTS.
const Schema = `
CREATE TABLE IF NOT EXISTS mirror_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mailbox_state (
  mailbox_id   TEXT NOT NULL,
  message_id   TEXT NOT NULL,
  uid          INTEGER NOT NULL,
  uid_validity INTEGER NOT NULL,
  change_id    INTEGER NOT NULL,
  flags_json   TEXT NOT NULL DEFAULT '[]',
  read_at      TEXT,
  expunged_at  TEXT,
  PRIMARY KEY (mailbox_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_mailbox_state_change
  ON mailbox_state (mailbox_id, change_id);
CREATE INDEX IF NOT EXISTS idx_mailbox_state_uid
  ON mailbox_state (mailbox_id, uid);

CREATE TABLE IF NOT EXISTS mailbox_meta (
  mailbox_id   TEXT PRIMARY KEY,
  last_state   INTEGER NOT NULL DEFAULT 0,
  refreshed_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id                       TEXT PRIMARY KEY,
  mailbox_id               TEXT NOT NULL,
  from_addr                TEXT,
  subject                  TEXT,
  header_message_id        TEXT,
  body_bytes               INTEGER,
  attachments_total_bytes  INTEGER,
  created_at               TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_mailbox
  ON messages (mailbox_id, created_at DESC);
`
