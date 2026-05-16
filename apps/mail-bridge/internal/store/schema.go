// Package store is the bridge-local SQLite mirror of polaris mailbox state.
//
// Latency motivation (per plan section L.9): D1 round-trips from regions
// distant from the API origin are 150–300ms — unacceptable for an
// interactive mail client. The bridge keeps a local SQLite mirror so that
// FETCH/STATUS/SELECT can resolve metadata without crossing the WAN.
//
// Implementation uses `modernc.org/sqlite` (pure-Go, no CGO) so the bridge
// stays statically linkable.
//
// Schema migration model (Phase 4b.7):
//
//   - The Schema constant is the cold-start CREATE block. It uses
//     IF NOT EXISTS so re-running it against an existing DB is harmless.
//   - SchemaMigrations is a numbered list of pending ALTERs. Each entry's
//     index in the slice is its version number; on Open we read the
//     `schema_version.version` row, then run every migration whose index
//     is greater than the stored version, bumping `schema_version.version`
//     after each. Duplicate-column errors are tolerated for migrations
//     that landed before the version table existed.
//   - To add a column or table change: append a new entry to
//     SchemaMigrations. NEVER reorder, remove, or edit a published entry
//     (every operator's mirror.db has applied them in slice order).
package store

// Schema is the cold-start CREATE block. Idempotent — every CREATE uses
// IF NOT EXISTS.
const Schema = `
CREATE TABLE IF NOT EXISTS mirror_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_version (
  -- Single-row table holding the highest applied SchemaMigrations index.
  -- id is a constant so the table is upserted, not appended to.
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO schema_version (id, version) VALUES (1, 0);

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
  refreshed_at TEXT,
  -- uid_validity is the IMAP UIDVALIDITY reported on SELECT. Sourced from
  -- the polaris control plane (Phase 2e bug #8 — was previously derived
  -- from MAX(uid_validity) on mailbox_state which masks transitions when
  -- only a subset of rows have been renumbered).
  uid_validity INTEGER NOT NULL DEFAULT 0
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

// SchemaMigrations are append-only, idempotent ALTERs applied after Schema.
// Index in this slice == version number tracked in schema_version.version.
//
// IMPORTANT: append only. Existing entries are immutable — every operator's
// mirror.db has executed them in this exact order, so re-ordering or
// editing breaks already-migrated DBs.
//
// Migration 0 (uid_validity column) predates the version table; it is
// idempotent (duplicate-column errors are tolerated) so re-running it
// against an already-migrated DB is safe.
var SchemaMigrations = []string{
	// version 1 — add uid_validity to mailbox_meta.
	`ALTER TABLE mailbox_meta ADD COLUMN uid_validity INTEGER NOT NULL DEFAULT 0`,
}
