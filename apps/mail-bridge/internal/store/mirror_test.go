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
