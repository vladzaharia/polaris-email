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
	return &Mirror{DB: db}, nil
}

// Close shuts the mirror down.
func (m *Mirror) Close() error { return m.DB.Close() }

// GetMessageMeta returns the cached metadata row, or sql.ErrNoRows.
func (m *Mirror) GetMessageMeta(ctx context.Context, messageID string) (*MessageMeta, error) {
	row := m.DB.QueryRowContext(ctx,
		`SELECT id, mailbox_id, COALESCE(from_addr,''), COALESCE(subject,''),
		        COALESCE(header_message_id,''), COALESCE(body_bytes,0),
		        COALESCE(attachments_total_bytes,0), COALESCE(created_at,'')
		 FROM messages WHERE id = ?`, messageID)
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
func (m *Mirror) GetMailboxState(ctx context.Context, mailboxID string) (*MailboxSummary, error) {
	s := &MailboxSummary{}
	if err := m.DB.QueryRowContext(ctx,
		`SELECT
		   COUNT(*) FILTER (WHERE expunged_at IS NULL),
		   COUNT(*) FILTER (WHERE expunged_at IS NULL AND read_at IS NULL),
		   COALESCE(MAX(uid_validity),0),
		   COALESCE(MAX(uid),0)+1,
		   COALESCE(MAX(change_id),0)
		 FROM mailbox_state WHERE mailbox_id = ?`, mailboxID).
		Scan(&s.Exists, &s.Unseen, &s.UIDValidity, &s.UIDNext, &s.HighestModSeq); err != nil {
		return nil, err
	}
	_ = m.DB.QueryRowContext(ctx,
		`SELECT last_state FROM mailbox_meta WHERE mailbox_id = ?`, mailboxID).
		Scan(&s.LastState)
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

// Changes is the parsed JMAP-style delta returned from the SDK.
type Changes struct {
	Updated []string
	Deleted []string
	State   int64
}

// ApplyChanges merges a change-set into the mirror. Updated entries are
// re-fetched lazily on next FETCH (the bridge calls BulkGetMessages and
// then UpsertMessageMeta). Deleted entries are marked expunged.
func (m *Mirror) ApplyChanges(ctx context.Context, mailboxID string, ch Changes) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	tx, err := m.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	now := time.Now().UTC().Format(time.RFC3339)
	for _, id := range ch.Deleted {
		if _, err := tx.ExecContext(ctx,
			`UPDATE mailbox_state SET expunged_at = ?, change_id = ?
			 WHERE mailbox_id = ? AND message_id = ?`,
			now, ch.State, mailboxID, id); err != nil {
			return err
		}
	}
	for _, id := range ch.Updated {
		if _, err := tx.ExecContext(ctx,
			`UPDATE mailbox_state SET change_id = ?
			 WHERE mailbox_id = ? AND message_id = ?`,
			ch.State, mailboxID, id); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO mailbox_meta (mailbox_id, last_state, refreshed_at)
		VALUES (?, ?, ?)
		ON CONFLICT (mailbox_id) DO UPDATE SET
		  last_state = excluded.last_state, refreshed_at = excluded.refreshed_at
	`, mailboxID, ch.State, now); err != nil {
		return err
	}
	return tx.Commit()
}

// LastState returns the last-known JMAP state token for a mailbox (0 if none).
func (m *Mirror) LastState(ctx context.Context, mailboxID string) (int64, error) {
	var s int64
	err := m.DB.QueryRowContext(ctx,
		`SELECT last_state FROM mailbox_meta WHERE mailbox_id = ?`, mailboxID).Scan(&s)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return s, err
}

func nullable(s sql.NullString) any {
	if !s.Valid {
		return nil
	}
	return s.String
}
