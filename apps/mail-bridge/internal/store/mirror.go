// Mirror is the bridge-local mailbox state cache.
//
// Responsibility split:
//   - Reads (GetMailboxState, GetMessageMeta) hit the local DB first; on
//     miss the caller falls back to the SDK and then ApplyMetadata.
//   - Writes (ApplyChanges, ApplyMetadata) merge SDK responses into the
//     local DB. Polaris is always authoritative; conflicts resolve to the
//     polaris row.
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite" // register the modernc sqlite driver
)

// MessageMeta is the lightweight metadata row mirrored locally.
type MessageMeta struct {
	ID                    string
	MailboxID             string
	FromAddr              string
	Subject               string
	HeaderMessageID       string
	BodyBytes             int64
	AttachmentsTotalBytes int64
	CreatedAt             string
}

// MailboxState is the per-(mailbox,message) row mirrored locally.
type MailboxState struct {
	MailboxID   string
	MessageID   string
	UID         int64
	UIDValidity int64
	ChangeID    int64
	Flags       string // JSON array
	ReadAt      sql.NullString
	ExpungedAt  sql.NullString
}

// MailboxSummary is the aggregate state used for IMAP SELECT.
type MailboxSummary struct {
	Exists        int
	Unseen        int
	UIDValidity   int64
	UIDNext       int64
	HighestModSeq int64
	LastState     int64
}

// Mirror wraps the SQLite database.
type Mirror struct {
	mu sync.Mutex
	DB *sql.DB
}

// Open opens (or creates) the SQLite file at path and applies the schema.
// path may be ":memory:" for tests.
func Open(path string) (*Mirror, error) {
	if path == "" {
		return nil, errors.New("store.Open: empty path")
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	// Enable WAL + foreign keys for a real on-disk file. In-memory uses
	// default journal.
	if path != ":memory:" {
		if _, err := db.Exec(`PRAGMA journal_mode=WAL;`); err != nil {
			_ = db.Close()
			return nil, err
		}
	}
	if _, err := db.Exec(Schema); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("mirror schema: %w", err)
	}
	// Apply pending migrations using schema_version (Phase 4b.7). The
	// stored version is the highest 1-based migration index already applied;
	// we run every entry past that point and bump the row after each. An
	// older bridge upgraded against a DB that predates the schema_version
	// table starts at version 0 — re-running migration 1 is harmless because
	// "duplicate column" errors are still tolerated.
	currentVersion, err := readSchemaVersion(db)
	if err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("mirror schema_version read: %w", err)
	}
	for i, stmt := range SchemaMigrations {
		nextVersion := i + 1
		if nextVersion <= currentVersion {
			continue
		}
		if _, err := db.Exec(stmt); err != nil {
			if !isDuplicateColumnErr(err) {
				_ = db.Close()
				return nil, fmt.Errorf("mirror migration v%d %q: %w", nextVersion, stmt, err)
			}
		}
		if _, err := db.Exec(`UPDATE schema_version SET version = ? WHERE id = 1`, nextVersion); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("mirror schema_version update v%d: %w", nextVersion, err)
		}
	}
	return &Mirror{DB: db}, nil
}

// readSchemaVersion returns the highest applied migration index. Returns 0
// when the DB predates the schema_version table (i.e. the SELECT errors out)
// — Schema's CREATE+INSERT-OR-IGNORE block has already run, so any missing
// row is treated as version 0 and all migrations re-apply (idempotently).
func readSchemaVersion(db *sql.DB) (int, error) {
	var v int
	err := db.QueryRow(`SELECT version FROM schema_version WHERE id = 1`).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return v, nil
}

// isDuplicateColumnErr matches the modernc.org/sqlite error returned when
// ALTER TABLE ADD COLUMN targets an already-existing column. We can't use
// errors.Is because the driver returns a string-formatted error; substring
// match is the supported approach.
func isDuplicateColumnErr(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "duplicate column")
}

// Close shuts the mirror down.
func (m *Mirror) Close() error { return m.DB.Close() }

// GetMessageMeta returns the cached metadata row, or sql.ErrNoRows.
// mailboxID scopes the lookup; a fetch for a message in a different
// mailbox returns sql.ErrNoRows even if the message exists in the mirror.
// This prevents cross-mailbox metadata leaks if a session ever ends up
// holding a message id that doesn't belong to its selected mailbox.
func (m *Mirror) GetMessageMeta(
	ctx context.Context,
	mailboxID, messageID string,
) (*MessageMeta, error) {
	row := m.DB.QueryRowContext(ctx,
		`SELECT id, mailbox_id, COALESCE(from_addr,''), COALESCE(subject,''),
		        COALESCE(header_message_id,''), COALESCE(body_bytes,0),
		        COALESCE(attachments_total_bytes,0), COALESCE(created_at,'')
		 FROM messages WHERE id = ? AND mailbox_id = ?`, messageID, mailboxID)
	mm := &MessageMeta{}
	if err := row.Scan(&mm.ID, &mm.MailboxID, &mm.FromAddr, &mm.Subject,
		&mm.HeaderMessageID, &mm.BodyBytes, &mm.AttachmentsTotalBytes, &mm.CreatedAt); err != nil {
		return nil, err
	}
	return mm, nil
}

// UpsertMessageMeta writes (or replaces) one metadata row.
func (m *Mirror) UpsertMessageMeta(ctx context.Context, mm MessageMeta) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, err := m.DB.ExecContext(ctx, `
		INSERT INTO messages (id, mailbox_id, from_addr, subject, header_message_id,
		                     body_bytes, attachments_total_bytes, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET
		  mailbox_id              = excluded.mailbox_id,
		  from_addr               = excluded.from_addr,
		  subject                 = excluded.subject,
		  header_message_id       = excluded.header_message_id,
		  body_bytes              = excluded.body_bytes,
		  attachments_total_bytes = excluded.attachments_total_bytes,
		  created_at              = excluded.created_at
	`, mm.ID, mm.MailboxID, mm.FromAddr, mm.Subject, mm.HeaderMessageID,
		mm.BodyBytes, mm.AttachmentsTotalBytes, mm.CreatedAt)
	return err
}

// GetMailboxState returns the aggregate mailbox summary (EXISTS, UIDNEXT, etc).
//
// UIDValidity is sourced exclusively from `mailbox_meta.uid_validity`
// previously this query computed `MAX(uid_validity)` over `mailbox_state`
// rows which would silently mask a UIDVALIDITY transition (control-plane
// renumber that hasn't reached every row yet). The IMAP RFC requires
// UIDVALIDITY to be a single per-mailbox monotonically-increasing value;
// folding in stale per-row values would produce an incoherent SELECT.
//
// As a fallback for cold-start (mailbox_meta row not yet written), we fall
// back to MAX(uid_validity) from mailbox_state so newly-bootstrapped
// bridges still report a value rather than 0; the next refresh will write
// the authoritative value.
func (m *Mirror) GetMailboxState(ctx context.Context, mailboxID string) (*MailboxSummary, error) {
	s := &MailboxSummary{}
	if err := m.DB.QueryRowContext(ctx,
		`SELECT
		   COUNT(*) FILTER (WHERE expunged_at IS NULL),
		   COUNT(*) FILTER (WHERE expunged_at IS NULL AND read_at IS NULL),
		   COALESCE(MAX(uid),0)+1,
		   COALESCE(MAX(change_id),0)
		 FROM mailbox_state WHERE mailbox_id = ?`, mailboxID).
		Scan(&s.Exists, &s.Unseen, &s.UIDNext, &s.HighestModSeq); err != nil {
		return nil, err
	}
	var (
		metaUIDValidity sql.NullInt64
		lastState       sql.NullInt64
	)
	_ = m.DB.QueryRowContext(ctx,
		`SELECT last_state, uid_validity FROM mailbox_meta WHERE mailbox_id = ?`, mailboxID).
		Scan(&lastState, &metaUIDValidity)
	if metaUIDValidity.Valid && metaUIDValidity.Int64 > 0 {
		s.UIDValidity = metaUIDValidity.Int64
	} else {
		// Cold-start fallback — meta hasn't been populated yet. Use the
		// highest per-row value so SELECT after a fresh bootstrap doesn't
		// report UIDVALIDITY=0 (clients treat that as "discard cache").
		_ = m.DB.QueryRowContext(ctx,
			`SELECT COALESCE(MAX(uid_validity),0) FROM mailbox_state WHERE mailbox_id = ?`, mailboxID).
			Scan(&s.UIDValidity)
	}
	if lastState.Valid {
		s.LastState = lastState.Int64
	}
	return s, nil
}

// ListLiveMessageIDs returns non-expunged message ids ordered by UID for
// IMAP sequence/UID mapping.
func (m *Mirror) ListLiveMessageIDs(ctx context.Context, mailboxID string) ([]MailboxState, error) {
	rows, err := m.DB.QueryContext(ctx,
		`SELECT mailbox_id, message_id, uid, uid_validity, change_id, flags_json, read_at, expunged_at
		 FROM mailbox_state WHERE mailbox_id = ? AND expunged_at IS NULL
		 ORDER BY uid ASC`, mailboxID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MailboxState
	for rows.Next() {
		var s MailboxState
		if err := rows.Scan(&s.MailboxID, &s.MessageID, &s.UID, &s.UIDValidity,
			&s.ChangeID, &s.Flags, &s.ReadAt, &s.ExpungedAt); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// UpsertState writes a single mailbox_state row.
func (m *Mirror) UpsertState(ctx context.Context, s MailboxState) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, err := m.DB.ExecContext(ctx, `
		INSERT INTO mailbox_state (mailbox_id, message_id, uid, uid_validity, change_id, flags_json, read_at, expunged_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (mailbox_id, message_id) DO UPDATE SET
		  uid          = excluded.uid,
		  uid_validity = excluded.uid_validity,
		  change_id    = excluded.change_id,
		  flags_json   = excluded.flags_json,
		  read_at      = excluded.read_at,
		  expunged_at  = excluded.expunged_at
	`, s.MailboxID, s.MessageID, s.UID, s.UIDValidity, s.ChangeID, s.Flags,
		nullable(s.ReadAt), nullable(s.ExpungedAt))
	return err
}

// Changes is the parsed mailbox delta returned from the SDK.
type Changes struct {
	// Added is the set of newly-introduced message ids (polaris assigned).
	// Pre-Phase-4b ApplyChanges only handled Updated/Deleted, so brand-new
	// messages were silently dropped — IMAP FETCH after an IDLE notification
	// found nothing because no row had been inserted. Now Added entries are
	// upserted as placeholder rows; full metadata fills in lazily on next
	// FETCH (BulkGetMessages → UpsertMessageMeta) or webhook-driven refresh.
	Added   []string
	Updated []string
	Deleted []string
	State   int64
	// UIDValidity is the new authoritative UIDVALIDITY for the mailbox. If
	// 0 (the zero value) the existing mailbox_meta.uid_validity is left
	// untouched; this lets refresh paths that don't fetch the value omit it
	// without clobbering the cached one.
	UIDValidity int64
}

// ApplyChanges merges a change-set into the mirror. Updated entries are
// re-fetched lazily on next FETCH (the bridge calls BulkGetMessages and
// then UpsertMessageMeta). Deleted entries are marked expunged. Added
// entries (and any Updated entries with no existing row — defensive
// fallback for cases where the bridge first observes a message via the
// Updated channel after a missed Added event) are inserted as placeholder
// rows with a locally-allocated UID; the next refresh fills in flags and
// metadata authoritatively.
func (m *Mirror) ApplyChanges(ctx context.Context, mailboxID string, ch Changes) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	tx, err := m.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	now := time.Now().UTC().Format(time.RFC3339)

	// Resolve the UIDVALIDITY we'll stamp onto inserted placeholder rows.
	// Order: explicit ch.UIDValidity > current mailbox_meta.uid_validity >
	// 1 (cold start before meta is written). Per-row fallback to MAX(uid_validity)
	// avoids inserting 0, which IMAP clients treat as "discard cache".
	var uidValidity int64
	switch {
	case ch.UIDValidity > 0:
		uidValidity = ch.UIDValidity
	default:
		var existing sql.NullInt64
		_ = tx.QueryRowContext(ctx,
			`SELECT uid_validity FROM mailbox_meta WHERE mailbox_id = ?`, mailboxID).Scan(&existing)
		if existing.Valid && existing.Int64 > 0 {
			uidValidity = existing.Int64
		} else {
			var rowMax sql.NullInt64
			_ = tx.QueryRowContext(ctx,
				`SELECT MAX(uid_validity) FROM mailbox_state WHERE mailbox_id = ?`, mailboxID).Scan(&rowMax)
			if rowMax.Valid && rowMax.Int64 > 0 {
				uidValidity = rowMax.Int64
			} else {
				uidValidity = 1
			}
		}
	}

	// Helper: insert a placeholder row for id if not present. UID is the
	// next available slot in this mailbox (MAX(uid)+1). The placeholder
	// has empty flags and no read_at / expunged_at. Returns (inserted, err).
	insertPlaceholder := func(id string) error {
		// INSERT OR IGNORE so an already-present row is left alone (the
		// subsequent change_id UPDATE handles the merge case).
		var nextUID int64
		if err := tx.QueryRowContext(ctx,
			`SELECT COALESCE(MAX(uid),0)+1 FROM mailbox_state WHERE mailbox_id = ?`, mailboxID).
			Scan(&nextUID); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `
			INSERT OR IGNORE INTO mailbox_state
			  (mailbox_id, message_id, uid, uid_validity, change_id, flags_json, read_at, expunged_at)
			VALUES (?, ?, ?, ?, ?, '[]', NULL, NULL)
		`, mailboxID, id, nextUID, uidValidity, ch.State)
		return err
	}

	for _, id := range ch.Deleted {
		if _, err := tx.ExecContext(ctx,
			`UPDATE mailbox_state SET expunged_at = ?, change_id = ?
			 WHERE mailbox_id = ? AND message_id = ?`,
			now, ch.State, mailboxID, id); err != nil {
			return err
		}
	}
	for _, id := range ch.Added {
		if err := insertPlaceholder(id); err != nil {
			return err
		}
	}
	for _, id := range ch.Updated {
		// First try a placeholder insert (no-op if already present).
		// This recovers from a missed Added event: if the bridge first
		// learns of the message via Updated, we still get a row.
		if err := insertPlaceholder(id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE mailbox_state SET change_id = ?
			 WHERE mailbox_id = ? AND message_id = ?`,
			ch.State, mailboxID, id); err != nil {
			return err
		}
	}
	if ch.UIDValidity > 0 {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO mailbox_meta (mailbox_id, last_state, refreshed_at, uid_validity)
			VALUES (?, ?, ?, ?)
			ON CONFLICT (mailbox_id) DO UPDATE SET
			  last_state   = excluded.last_state,
			  refreshed_at = excluded.refreshed_at,
			  uid_validity = excluded.uid_validity
		`, mailboxID, ch.State, now, ch.UIDValidity); err != nil {
			return err
		}
	} else {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO mailbox_meta (mailbox_id, last_state, refreshed_at)
			VALUES (?, ?, ?)
			ON CONFLICT (mailbox_id) DO UPDATE SET
			  last_state = excluded.last_state, refreshed_at = excluded.refreshed_at
		`, mailboxID, ch.State, now); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// LastState returns the last-known mailbox state token for a mailbox (0 if none).
func (m *Mirror) LastState(ctx context.Context, mailboxID string) (int64, error) {
	var s int64
	err := m.DB.QueryRowContext(ctx,
		`SELECT last_state FROM mailbox_meta WHERE mailbox_id = ?`, mailboxID).Scan(&s)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return s, err
}

// MessageCount returns the total number of rows in the local mirror's
// `messages` table. Used by the heartbeat ticker to surface how much
// state this bridge is caching. Errors fall back to 0 (the heartbeat is
// best-effort telemetry and shouldn't fail on a transient SQLite hiccup).
func (m *Mirror) MessageCount() int64 {
	var n int64
	if err := m.DB.QueryRow(`SELECT COUNT(*) FROM messages`).Scan(&n); err != nil {
		return 0
	}
	return n
}

func nullable(s sql.NullString) any {
	if !s.Valid {
		return nil
	}
	return s.String
}
