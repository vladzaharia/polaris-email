package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// MirrorRow is the IMAP-facing per-message row joining mailbox_state +
// the cached messages metadata. It's used to render FETCH responses.
type MirrorRow struct {
	Seq             int
	UID             int64
	MessageID       string
	Flags           []string
	SizeBytes       int64
	InternalDate    string
	Subject         string
	From            string
	To              []string
	HeaderMessageID string
}

// MailboxState convenience wrapper for IMAP SELECT. Returns Total +
// UIDNext + UIDValidity + HighestModseq + Unseen in one call.
type MailboxStateView struct {
	Total         int
	Unseen        int
	NextUID       int64
	UIDValidity   int64
	HighestModseq int64
}

// MailboxState returns the IMAP-facing summary.
func (m *Mirror) MailboxState(ctx context.Context, mailboxID string) (*MailboxStateView, error) {
	s, err := m.GetMailboxState(ctx, mailboxID)
	if err != nil {
		return nil, err
	}
	return &MailboxStateView{
		Total:         s.Exists,
		Unseen:        s.Unseen,
		NextUID:       s.UIDNext,
		UIDValidity:   s.UIDValidity,
		HighestModseq: s.HighestModSeq,
	}, nil
}

// ListMessages returns the rows in a mailbox matching the given sequence
// set. byUID=true treats the set as UIDs; false treats it as sequence numbers
// (1-indexed by uid ascending). lo/hi=-1 means "max" / open-ended.
func (m *Mirror) ListMessages(ctx context.Context, mailboxID string, byUID bool, set [][2]int) ([]MirrorRow, error) {
	rows, err := m.DB.QueryContext(ctx, `
		SELECT s.uid, s.message_id, s.flags_json,
		       COALESCE(mm.body_bytes,0), COALESCE(mm.created_at,''),
		       COALESCE(mm.subject,''), COALESCE(mm.from_addr,''),
		       COALESCE(mm.header_message_id,'')
		FROM mailbox_state s
		LEFT JOIN messages mm ON mm.id = s.message_id
		WHERE s.mailbox_id = ? AND s.expunged_at IS NULL
		ORDER BY s.uid ASC`, mailboxID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	all := []MirrorRow{}
	for rows.Next() {
		var (
			r        MirrorRow
			flagsRaw string
		)
		if err := rows.Scan(&r.UID, &r.MessageID, &flagsRaw, &r.SizeBytes,
			&r.InternalDate, &r.Subject, &r.From, &r.HeaderMessageID); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(flagsRaw), &r.Flags)
		all = append(all, r)
	}
	// Assign sequence numbers (1-indexed).
	for i := range all {
		all[i].Seq = i + 1
	}
	// Filter by set.
	out := []MirrorRow{}
	for _, r := range all {
		if matchSet(set, r, byUID, len(all)) {
			out = append(out, r)
		}
	}
	return out, nil
}

func matchSet(set [][2]int, r MirrorRow, byUID bool, total int) bool {
	for _, p := range set {
		lo, hi := p[0], p[1]
		v := int(r.Seq)
		if byUID {
			v = int(r.UID)
		}
		if lo == -1 {
			lo = total
			if byUID {
				lo = int(r.UID)
			}
		}
		if hi == -1 {
			hi = 1 << 30 // open-ended upper
		}
		if v >= lo && v <= hi {
			return true
		}
	}
	return false
}

// UpdateFlags rewrites the flags JSON for one row.
//
// IMPORTANT: the column is `flags_json` per schema.go; the prior `flags`
// reference was a silent no-op (UPDATE on an unknown column raises in
// SQLite, but the error was swallowed by the caller in
// imap.bridgeSession.Store), so STORE acked the client without persisting.
// The Phase 2e mirror_test below exercises the read-back path.
func (m *Mirror) UpdateFlags(ctx context.Context, mailboxID, messageID string, flags []string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	flagsJSON, _ := json.Marshal(flags)
	_, err := m.DB.ExecContext(ctx,
		`UPDATE mailbox_state SET flags_json = ? WHERE mailbox_id = ? AND message_id = ?`,
		string(flagsJSON), mailboxID, messageID)
	return err
}

// MarkExpunged stamps expunged_at on a row (soft delete in the local mirror).
func (m *Mirror) MarkExpunged(ctx context.Context, mailboxID, messageID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, err := m.DB.ExecContext(ctx,
		`UPDATE mailbox_state SET expunged_at = ? WHERE mailbox_id = ? AND message_id = ?`,
		time.Now().UTC().Format(time.RFC3339), mailboxID, messageID)
	return err
}

// ToString returns the flags JSON as a printable list for diagnostics.
func (r MirrorRow) FlagsString() string {
	return strings.Join(r.Flags, " ")
}

// Inspect is a debug helper used by some tests.
func (r MirrorRow) String() string {
	return fmt.Sprintf("seq=%d uid=%d id=%s flags=[%s]", r.Seq, r.UID, r.MessageID, r.FlagsString())
}
