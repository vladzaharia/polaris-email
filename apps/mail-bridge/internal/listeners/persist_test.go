package listeners

import (
	"context"
	"path/filepath"
	"testing"
)

func sampleSettings() Settings {
	return Settings{
		Version:         3,
		SMTPSEnabled:    true,
		SMTPSPort:       465,
		IMAPSEnabled:    true,
		IMAPSPort:       993,
		TLSSource:       "auto",
		MaxMessageSize:  52428800,
		MaxIMAPSessions: 200,
		LogLevel:        "info",
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	want := sampleSettings()
	if err := SaveSettings(path, want); err != nil {
		t.Fatalf("SaveSettings: %v", err)
	}
	got, found, err := LoadSettings(path, Settings{})
	if err != nil {
		t.Fatalf("LoadSettings: %v", err)
	}
	if !found {
		t.Fatal("found = false, want true after a save")
	}
	if got != want {
		t.Fatalf("round-trip mismatch:\n got %+v\nwant %+v", got, want)
	}
}

func TestLoadMissingReturnsBaseNotFound(t *testing.T) {
	base := sampleSettings()
	got, found, err := LoadSettings(filepath.Join(t.TempDir(), "absent.json"), base)
	if err != nil {
		t.Fatalf("LoadSettings on missing file: unexpected err %v", err)
	}
	if found {
		t.Fatal("found = true, want false for a missing file")
	}
	if got != base {
		t.Fatalf("missing-file load changed base: got %+v want %+v", got, base)
	}
}

// An on-disk file written by an older binary won't contain every field.
// LoadSettings overlays the JSON onto base, so a field ABSENT from the
// file keeps base's value rather than being zeroed.
func TestLoadOverlaysOntoBase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "partial.json")
	// Hand-write JSON that omits max_imap_sessions + log_level entirely
	// (simulating a snapshot from before those fields existed).
	raw := []byte(`{"version":5,"max_message_size":12345,"smtps_enabled":true}`)
	if err := atomicWriteFile(path, raw, 0o600); err != nil {
		t.Fatalf("write raw: %v", err)
	}
	base := sampleSettings() // MaxIMAPSessions=200, LogLevel=info
	got, found, err := LoadSettings(path, base)
	if err != nil || !found {
		t.Fatalf("LoadSettings: found=%v err=%v", found, err)
	}
	if got.MaxMessageSize != 12345 || got.Version != 5 {
		t.Fatalf("persisted fields not applied: %+v", got)
	}
	// Absent fields retain base.
	if got.MaxIMAPSessions != 200 {
		t.Fatalf("MaxIMAPSessions = %d, want 200 (base retained for absent field)", got.MaxIMAPSessions)
	}
	if got.LogLevel != "info" {
		t.Fatalf("LogLevel = %q, want info (base retained for absent field)", got.LogLevel)
	}
}

// The core convergence guarantee: a restart-required change persists the
// new snapshot so the next boot can re-seed it.
func TestApplyPersistsRestartRequired(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	// All listeners disabled ⇒ Start/Apply touch no real sockets.
	base := Settings{Version: 1, MaxMessageSize: 26214400}
	s := New(Deps{SettingsPath: path})
	if err := s.Start(context.Background(), base); err != nil {
		t.Fatalf("Start: %v", err)
	}
	next := base
	next.Version = 2
	next.MaxMessageSize = 52428800 // restart-required field change
	restart, err := s.Apply(context.Background(), next)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if !restart {
		t.Fatal("restartRequired = false, want true for a message-size change")
	}
	got, found, err := LoadSettings(path, Settings{})
	if err != nil || !found {
		t.Fatalf("expected persisted file after restart-required Apply: found=%v err=%v", found, err)
	}
	if got.Version != 2 || got.MaxMessageSize != 52428800 {
		t.Fatalf("persisted snapshot wrong: %+v", got)
	}
}

func TestApplyPersistsHotChange(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	base := Settings{Version: 1, LogLevel: "info", MaxMessageSize: 52428800}
	s := New(Deps{SettingsPath: path})
	if err := s.Start(context.Background(), base); err != nil {
		t.Fatalf("Start: %v", err)
	}
	next := base
	next.Version = 2
	next.LogLevel = "debug" // hot-appliable, no restart
	restart, err := s.Apply(context.Background(), next)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if restart {
		t.Fatal("restartRequired = true, want false for a log-level change")
	}
	got, _, err := LoadSettings(path, Settings{})
	if err != nil {
		t.Fatalf("LoadSettings: %v", err)
	}
	if got.Version != 2 || got.LogLevel != "debug" {
		t.Fatalf("hot-apply not persisted: %+v", got)
	}
}

// Persistence is disabled when SettingsPath is empty (no file created).
func TestApplyNoPersistWhenPathEmpty(t *testing.T) {
	s := New(Deps{})
	base := Settings{Version: 1}
	if err := s.Start(context.Background(), base); err != nil {
		t.Fatalf("Start: %v", err)
	}
	next := base
	next.Version = 2
	next.MaxMessageSize = 999
	if _, err := s.Apply(context.Background(), next); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	// Nothing to assert beyond "did not panic / no path required".
}
