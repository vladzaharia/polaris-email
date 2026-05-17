package state

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestRead_MissingFileReturnsFreshDoc(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	s := Open(filepath.Join(dir, "nope.json"))
	d, err := s.Read()
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if d.SchemaVersion != CurrentSchema {
		t.Errorf("want schema %d, got %d", CurrentSchema, d.SchemaVersion)
	}
	if d.CreatedAt.IsZero() {
		t.Error("want CreatedAt populated on fresh doc")
	}
}

func TestWriteRead_RoundTrip(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	s := Open(filepath.Join(dir, "state.json"))

	orig := &Doc{
		SchemaVersion: CurrentSchema,
		AccountID:     "acc-123",
		D1:            map[string]Resource{"polaris-email": {ID: "db-1", Name: "polaris-email"}},
		R2:            map[string]R2Bucket{"polaris-mail-archive": {Name: "polaris-mail-archive", Jurisdiction: "eu", ObjectLockHours: 2160}},
		KV:            map[string]Resource{"POLARIS_NONCE_DEDUP": {ID: "kv-1", Name: "POLARIS_NONCE_DEDUP"}},
		Queues:        map[string]Resource{"polaris-outbound": {ID: "q-1", Name: "polaris-outbound"}},
		Phases:        map[string]Phase{"preflight": {CompletedAt: time.Now().UTC(), ByVersion: "0.1.0"}},
	}
	if err := s.Write(orig); err != nil {
		t.Fatalf("Write: %v", err)
	}

	// File perms should be 0600.
	info, err := os.Stat(s.Path())
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("want mode 0600, got %o", info.Mode().Perm())
	}

	back, err := s.Read()
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if back.AccountID != orig.AccountID {
		t.Errorf("AccountID: want %q got %q", orig.AccountID, back.AccountID)
	}
	if back.D1["polaris-email"].ID != "db-1" {
		t.Errorf("D1 round-trip mismatch: %+v", back.D1)
	}
	if back.R2["polaris-mail-archive"].Jurisdiction != "eu" {
		t.Errorf("R2 jurisdiction lost: %+v", back.R2)
	}
	if back.R2["polaris-mail-archive"].ObjectLockHours != 2160 {
		t.Errorf("R2 ObjectLockHours lost: %+v", back.R2)
	}
	if back.UpdatedAt.IsZero() {
		t.Error("UpdatedAt should be stamped on Write")
	}
}

func TestWrite_AtomicNoOrphanTemp(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	s := Open(filepath.Join(dir, "state.json"))
	if err := s.Write(&Doc{SchemaVersion: CurrentSchema, AccountID: "a"}); err != nil {
		t.Fatalf("Write: %v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	for _, e := range entries {
		if filepath.Ext(e.Name()) == ".tmp" {
			t.Errorf("orphan tempfile left behind: %s", e.Name())
		}
	}
}

func TestLock_BlocksConcurrentWriter(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	s := Open(filepath.Join(dir, "state.json"))

	// Goroutine A: take exclusive lock, hold for ~60ms while a counter
	// gets bumped, then release.
	acquired := make(chan struct{})
	var counter atomic.Int32
	holdFor := 60 * time.Millisecond
	go func() {
		unlock, err := s.Lock(true)
		if err != nil {
			t.Errorf("A Lock: %v", err)
			close(acquired)
			return
		}
		close(acquired)
		counter.Store(1)
		time.Sleep(holdFor)
		_ = unlock()
	}()

	<-acquired

	// Goroutine B: try to acquire — should block until A releases. Since
	// A holds the lock for `holdFor`, B must wait at least that long.
	start := time.Now()
	unlock, err := s.Lock(true)
	if err != nil {
		t.Fatalf("B Lock: %v", err)
	}
	waited := time.Since(start)
	// Allow a generous lower bound (half the hold time) — exactly meeting
	// holdFor depends on scheduler timing.
	if waited < holdFor/2 {
		t.Errorf("B Lock acquired too quickly (%s, want ≥%s) — flock did not block", waited, holdFor/2)
	}
	if counter.Load() != 1 {
		t.Errorf("counter not yet bumped — happens-before broken")
	}
	if err := unlock(); err != nil {
		t.Errorf("B unlock: %v", err)
	}
}

func TestLock_Shared(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	s := Open(filepath.Join(dir, "state.json"))

	// Two shared locks should both succeed without blocking.
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			unlock, err := s.Lock(false)
			if err != nil {
				t.Errorf("shared Lock: %v", err)
				return
			}
			time.Sleep(10 * time.Millisecond)
			_ = unlock()
		}()
	}
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(200 * time.Millisecond):
		t.Fatal("shared locks should not have blocked each other")
	}
}

func TestRead_PreservesDiscoveredFlag(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	s := Open(filepath.Join(dir, "state.json"))
	orig := &Doc{
		SchemaVersion: CurrentSchema,
		D1:            map[string]Resource{"foo": {ID: "x", Name: "foo", Discovered: true}},
	}
	if err := s.Write(orig); err != nil {
		t.Fatalf("Write: %v", err)
	}
	back, err := s.Read()
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if !back.D1["foo"].Discovered {
		t.Error("Discovered flag should round-trip")
	}
}

func TestRead_EmptyFileReturnsFreshDoc(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	p := filepath.Join(dir, "state.json")
	if err := os.WriteFile(p, nil, 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	s := Open(p)
	d, err := s.Read()
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if d.SchemaVersion != CurrentSchema {
		t.Errorf("want schema %d, got %d", CurrentSchema, d.SchemaVersion)
	}
}

// Sanity check that the JSON we write is valid JSON (catches regressions
// where we forget the trailing newline trim or accidentally introduce a
// BOM).
func TestWrite_EmitsValidJSON(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	s := Open(filepath.Join(dir, "state.json"))
	if err := s.Write(&Doc{SchemaVersion: CurrentSchema, AccountID: "acc"}); err != nil {
		t.Fatalf("Write: %v", err)
	}
	b, err := os.ReadFile(s.Path())
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	var any map[string]any
	if err := json.Unmarshal(b, &any); err != nil {
		t.Errorf("written file is not valid JSON: %v\n--- contents ---\n%s", err, string(b))
	}
}
