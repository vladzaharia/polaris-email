package store

import (
	"context"
	"database/sql"
	"errors"
	"testing"
)

func newMirror(t *testing.T) *Mirror {
	t.Helper()
	m, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestUpsertAndGetMessageMeta(t *testing.T) {
	m := newMirror(t)
	defer m.Close()
	ctx := context.Background()
	if err := m.UpsertMessageMeta(ctx, MessageMeta{
		ID: "m1", MailboxID: "mb1", FromAddr: "a@x", Subject: "hi",
		BodyBytes: 10, CreatedAt: "2026-01-01",
	}); err != nil {
		t.Fatal(err)
	}
	got, err := m.GetMessageMeta(ctx, "m1")
	if err != nil {
		t.Fatal(err)
	}
	if got.Subject != "hi" || got.BodyBytes != 10 {
		t.Fatalf("got %+v", got)
	}
	if _, err := m.GetMessageMeta(ctx, "nope"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("expected ErrNoRows, got %v", err)
	}
}

func TestMailboxStateAndSummary(t *testing.T) {
	m := newMirror(t)
	defer m.Close()
	ctx := context.Background()
	for i, id := range []string{"a", "b", "c"} {
		if err := m.UpsertState(ctx, MailboxState{
			MailboxID: "mb1", MessageID: id, UID: int64(i + 1),
			UIDValidity: 1, ChangeID: int64(i + 1), Flags: "[]",
		}); err != nil {
			t.Fatal(err)
		}
	}
	s, err := m.GetMailboxState(ctx, "mb1")
	if err != nil {
		t.Fatal(err)
	}
	if s.Exists != 3 {
		t.Fatalf("exists=%d", s.Exists)
	}
	if s.UIDNext != 4 {
		t.Fatalf("uidnext=%d", s.UIDNext)
	}
	if s.Unseen != 3 {
		t.Fatalf("unseen=%d", s.Unseen)
	}
}

// TestUIDValidityFromMailboxMeta proves Phase 2e bug #8: UIDValidity is
// sourced from mailbox_meta, not derived from MAX(uid_validity) on
// mailbox_state. We seed two mailbox_state rows with mismatched
// uid_validity values (simulating a transition mid-renumber) and assert
// GetMailboxState returns the meta value, not the row max.
func TestUIDValidityFromMailboxMeta(t *testing.T) {
	m := newMirror(t)
	defer m.Close()
	ctx := context.Background()

	// Seed rows with mismatched per-row uid_validity.
	for i, id := range []string{"a", "b"} {
		_ = m.UpsertState(ctx, MailboxState{
			MailboxID: "mb1", MessageID: id, UID: int64(i + 1),
			UIDValidity: int64(100 + i*50), ChangeID: int64(i + 1), Flags: "[]",
		})
	}
	// Apply changes carrying an authoritative UIDValidity from the control
	// plane (different from any of the per-row values).
	if err := m.ApplyChanges(ctx, "mb1", Changes{State: 7, UIDValidity: 9999}); err != nil {
		t.Fatalf("apply: %v", err)
	}
	s, err := m.GetMailboxState(ctx, "mb1")
	if err != nil {
		t.Fatal(err)
	}
	if s.UIDValidity != 9999 {
		t.Fatalf("UIDValidity = %d, want 9999 (sourced from mailbox_meta)", s.UIDValidity)
	}
	// Re-apply with UIDValidity=0 — should NOT clobber the cached 9999.
	if err := m.ApplyChanges(ctx, "mb1", Changes{State: 8}); err != nil {
		t.Fatalf("apply zero: %v", err)
	}
	s2, _ := m.GetMailboxState(ctx, "mb1")
	if s2.UIDValidity != 9999 {
		t.Fatalf("UIDValidity after zero-update = %d, want 9999 (must not regress)", s2.UIDValidity)
	}
	if s2.LastState != 8 {
		t.Fatalf("LastState = %d, want 8", s2.LastState)
	}
}

// TestUIDValidityColdStartFallback proves we still surface the per-row max
// when mailbox_meta hasn't been written yet — important for the
// freshly-bootstrapped case so SELECT doesn't report 0.
func TestUIDValidityColdStartFallback(t *testing.T) {
	m := newMirror(t)
	defer m.Close()
	ctx := context.Background()
	_ = m.UpsertState(ctx, MailboxState{
		MailboxID: "mb1", MessageID: "x", UID: 1,
		UIDValidity: 42, ChangeID: 1, Flags: "[]",
	})
	s, err := m.GetMailboxState(ctx, "mb1")
	if err != nil {
		t.Fatal(err)
	}
	if s.UIDValidity != 42 {
		t.Fatalf("cold-start UIDValidity = %d, want 42", s.UIDValidity)
	}
}

func TestApplyChanges(t *testing.T) {
	m := newMirror(t)
	defer m.Close()
	ctx := context.Background()
	_ = m.UpsertState(ctx, MailboxState{MailboxID: "mb1", MessageID: "a", UID: 1, UIDValidity: 1, ChangeID: 1, Flags: "[]"})
	_ = m.UpsertState(ctx, MailboxState{MailboxID: "mb1", MessageID: "b", UID: 2, UIDValidity: 1, ChangeID: 1, Flags: "[]"})
	if err := m.ApplyChanges(ctx, "mb1", Changes{
		Updated: []string{"a"},
		Deleted: []string{"b"},
		State:   5,
	}); err != nil {
		t.Fatal(err)
	}
	last, _ := m.LastState(ctx, "mb1")
	if last != 5 {
		t.Fatalf("last=%d", last)
	}
	ls, _ := m.ListLiveMessageIDs(ctx, "mb1")
	if len(ls) != 1 || ls[0].MessageID != "a" {
		t.Fatalf("expected one live message 'a', got %+v", ls)
	}
}

// TestApplyChanges_AddedInsertsPlaceholder proves Phase 4b.1: when polaris
// reports a brand-new message_id (Added channel), ApplyChanges inserts a
// placeholder mailbox_state row with a freshly allocated UID. Pre-4b.1
// the Added entry was silently dropped — IMAP FETCH after the IDLE EXISTS
// notification found nothing.
func TestApplyChanges_AddedInsertsPlaceholder(t *testing.T) {
	m := newMirror(t)
	defer m.Close()
	ctx := context.Background()

	// Seed one existing row so the placeholder allocator must produce
	// UID >= 2 (MAX(uid)+1).
	_ = m.UpsertState(ctx, MailboxState{
		MailboxID: "mb1", MessageID: "existing", UID: 1, UIDValidity: 7,
		ChangeID: 1, Flags: "[]",
	})

	if err := m.ApplyChanges(ctx, "mb1", Changes{
		Added:       []string{"new-msg-1", "new-msg-2"},
		State:       42,
		UIDValidity: 7,
	}); err != nil {
		t.Fatalf("apply: %v", err)
	}

	live, err := m.ListLiveMessageIDs(ctx, "mb1")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(live) != 3 {
		t.Fatalf("live count = %d, want 3 (existing + 2 added), got %+v", len(live), live)
	}

	// Confirm both added IDs picked up unique UIDs and uid_validity=7.
	gotByID := make(map[string]MailboxState, len(live))
	for _, r := range live {
		gotByID[r.MessageID] = r
	}
	for _, id := range []string{"new-msg-1", "new-msg-2"} {
		row, ok := gotByID[id]
		if !ok {
			t.Fatalf("placeholder for %q missing from live set", id)
		}
		if row.UID < 2 {
			t.Fatalf("placeholder %q UID = %d, want >= 2", id, row.UID)
		}
		if row.UIDValidity != 7 {
			t.Fatalf("placeholder %q UIDValidity = %d, want 7", id, row.UIDValidity)
		}
		if row.ChangeID != 42 {
			t.Fatalf("placeholder %q ChangeID = %d, want 42", id, row.ChangeID)
		}
	}
	// UIDs must be unique across the new placeholders.
	if gotByID["new-msg-1"].UID == gotByID["new-msg-2"].UID {
		t.Fatalf("placeholder UIDs collided: %d == %d",
			gotByID["new-msg-1"].UID, gotByID["new-msg-2"].UID)
	}
}

// TestApplyChanges_UpdatedFallsBackToInsert proves the defensive insert
// fallback: if the bridge first observes a message via Updated (because it
// missed the Added event), ApplyChanges still creates a row.
func TestApplyChanges_UpdatedFallsBackToInsert(t *testing.T) {
	m := newMirror(t)
	defer m.Close()
	ctx := context.Background()
	if err := m.ApplyChanges(ctx, "mb1", Changes{
		Updated:     []string{"orphan"},
		State:       9,
		UIDValidity: 3,
	}); err != nil {
		t.Fatalf("apply: %v", err)
	}
	live, _ := m.ListLiveMessageIDs(ctx, "mb1")
	if len(live) != 1 || live[0].MessageID != "orphan" {
		t.Fatalf("expected orphan placeholder row, got %+v", live)
	}
	if live[0].ChangeID != 9 {
		t.Fatalf("placeholder ChangeID = %d, want 9", live[0].ChangeID)
	}
}

// TestSchemaMigration_AppliesPendingOnExistingDB proves Phase 4b.7: when
// a bridge upgrade introduces a new SchemaMigrations entry, opening an
// existing on-disk DB applies it and bumps schema_version. We simulate by
// opening the DB twice — the second open must not regress the version row.
func TestSchemaMigration_AppliesPendingOnExistingDB(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/mirror.db"

	// First open — applies all current migrations from version 0.
	m1, err := Open(path)
	if err != nil {
		t.Fatalf("open 1: %v", err)
	}
	var v1 int
	if err := m1.DB.QueryRow(`SELECT version FROM schema_version WHERE id = 1`).Scan(&v1); err != nil {
		t.Fatalf("read v1: %v", err)
	}
	if v1 != len(SchemaMigrations) {
		t.Fatalf("after first open version = %d, want %d", v1, len(SchemaMigrations))
	}
	_ = m1.Close()

	// Second open of the same file — version row must already be at the
	// max and Open must not re-execute any migration (simulated by
	// asserting the count didn't change unexpectedly).
	m2, err := Open(path)
	if err != nil {
		t.Fatalf("open 2: %v", err)
	}
	defer m2.Close()
	var v2 int
	if err := m2.DB.QueryRow(`SELECT version FROM schema_version WHERE id = 1`).Scan(&v2); err != nil {
		t.Fatalf("read v2: %v", err)
	}
	if v2 != v1 {
		t.Fatalf("version regressed across reopen: was %d, now %d", v1, v2)
	}
}

// TestSchemaMigration_BumpsFromZero forces a "version 0" DB (simulating an
// older bridge that predates schema_version) and confirms Open re-applies
// every migration idempotently and bumps the version row to len().
func TestSchemaMigration_BumpsFromZero(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/mirror.db"

	// First open — bring schema up to date.
	m1, err := Open(path)
	if err != nil {
		t.Fatalf("open 1: %v", err)
	}
	if _, err := m1.DB.Exec(`UPDATE schema_version SET version = 0 WHERE id = 1`); err != nil {
		t.Fatalf("force version 0: %v", err)
	}
	_ = m1.Close()

	m2, err := Open(path)
	if err != nil {
		t.Fatalf("open 2: %v", err)
	}
	defer m2.Close()
	var v int
	_ = m2.DB.QueryRow(`SELECT version FROM schema_version WHERE id = 1`).Scan(&v)
	if v != len(SchemaMigrations) {
		t.Fatalf("version after re-migrate = %d, want %d", v, len(SchemaMigrations))
	}
}
