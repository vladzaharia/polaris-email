package platform

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAtomicWrite_ModeIsRespected(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "subdir", "secret")
	if err := AtomicWrite(target, []byte("hunter2"), 0o600); err != nil {
		t.Fatalf("AtomicWrite: %v", err)
	}
	info, err := os.Stat(target)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("mode = %#o want 0600", got)
	}
	data, _ := os.ReadFile(target)
	if string(data) != "hunter2" {
		t.Fatalf("contents = %q", string(data))
	}
	// No leftover tempfile.
	if _, err := os.Stat(target + ".tmp"); !os.IsNotExist(err) {
		t.Fatalf("tempfile not cleaned up")
	}
}

func TestAtomicWrite_OverwritesExisting(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "f")
	if err := AtomicWrite(target, []byte("v1"), 0o600); err != nil {
		t.Fatalf("write1: %v", err)
	}
	if err := AtomicWrite(target, []byte("v2"), 0o600); err != nil {
		t.Fatalf("write2: %v", err)
	}
	data, _ := os.ReadFile(target)
	if string(data) != "v2" {
		t.Fatalf("got %q want v2", string(data))
	}
}

func TestEnsureDir(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "secrets")
	if err := EnsureDir(target, 0o700); err != nil {
		t.Fatalf("EnsureDir: %v", err)
	}
	info, err := os.Stat(target)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if got := info.Mode().Perm(); got != 0o700 {
		t.Fatalf("mode = %#o want 0700", got)
	}
	// Idempotency: a second call must remain 0700.
	_ = os.Chmod(target, 0o755)
	if err := EnsureDir(target, 0o700); err != nil {
		t.Fatalf("EnsureDir idempotent: %v", err)
	}
	info, _ = os.Stat(target)
	if got := info.Mode().Perm(); got != 0o700 {
		t.Fatalf("after re-enforce: mode = %#o want 0700", got)
	}
}

func TestRejectWorldReadableDir_OK(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "polaris-bridge")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := RejectWorldReadableDir(target); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRejectWorldReadableDir_Bad(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "bridge")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := RejectWorldReadableDir(target); err == nil {
		t.Fatalf("expected rejection for world-readable dir")
	}
}

func TestRejectWorldReadableDir_Missing(t *testing.T) {
	// Nonexistent target is acceptable — the wizard creates it.
	if err := RejectWorldReadableDir("/nonexistent/path/here"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}
