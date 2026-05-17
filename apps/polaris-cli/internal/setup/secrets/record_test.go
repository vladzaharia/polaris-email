package secrets

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRecorder_RoundTrip(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	path := filepath.Join(dir, "secrets.created.json")
	rec := NewRecorder(path)

	if rec.Has("api", "POLARIS_SECRET_A") {
		t.Fatal("empty record should not have any entry")
	}
	if err := rec.Record("api", "POLARIS_SECRET_A", "value-a", time.Now().UTC()); err != nil {
		t.Fatalf("Record: %v", err)
	}
	if !rec.Has("api", "POLARIS_SECRET_A") {
		t.Fatal("record should have the entry after Record()")
	}

	all, err := rec.All()
	if err != nil {
		t.Fatalf("All: %v", err)
	}
	if len(all) != 1 {
		t.Fatalf("All: want 1 entry, got %d", len(all))
	}
	want := sha256.Sum256([]byte("value-a"))
	if all[0].SHA256 != hex.EncodeToString(want[:]) {
		t.Errorf("sha mismatch: want %x got %s", want, all[0].SHA256)
	}
}

func TestRecorder_AppendOnly(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "secrets.created.json")
	rec := NewRecorder(path)
	t0 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	if err := rec.Record("api", "POLARIS_SECRET_A", "first", t0); err != nil {
		t.Fatal(err)
	}
	// Second call with a different value should be a no-op — first wins.
	if err := rec.Record("api", "POLARIS_SECRET_A", "second", t0.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	all, err := rec.All()
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 1 {
		t.Fatalf("want 1 entry, got %d", len(all))
	}
	firstSHA := sha256.Sum256([]byte("first"))
	if all[0].SHA256 != hex.EncodeToString(firstSHA[:]) {
		t.Errorf("first-wins violated: sha=%s", all[0].SHA256)
	}
}

func TestRecorder_FilePermissions(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "secrets.created.json")
	rec := NewRecorder(path)
	if err := rec.Record("api", "POLARIS_SECRET_A", "value", time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	mode := st.Mode().Perm()
	if mode != 0o600 {
		t.Errorf("mode: want 0600, got %o", mode)
	}
}

func TestRecorder_MissingFileMeansNoEntries(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "nonexistent.json")
	rec := NewRecorder(path)
	if rec.Has("api", "POLARIS_SECRET_A") {
		t.Error("missing file should report Has=false")
	}
	all, err := rec.All()
	if err != nil {
		t.Fatalf("All on missing file: %v", err)
	}
	if len(all) != 0 {
		t.Errorf("All on missing file: want empty, got %d", len(all))
	}
}

func TestRecorder_LegacyEmptyObjectIsTolerated(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "secrets.created.json")
	if err := os.WriteFile(path, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	rec := NewRecorder(path)
	if rec.Has("api", "POLARIS_SECRET_A") {
		t.Error("legacy `{}` file should report Has=false")
	}
	if err := rec.Record("api", "X", "v", time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	// Verify the file is now a JSON array, not an object.
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var arr []Entry
	if err := json.Unmarshal(data, &arr); err != nil {
		t.Fatalf("post-Record file should be a JSON array: %v", err)
	}
}

func TestRecorder_AllIsSorted(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "s.json")
	rec := NewRecorder(path)
	t0 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for _, e := range []struct {
		svc, name string
	}{
		{"panel", "OIDC_CLIENT_SECRET"},
		{"api", "POLARIS_SECRET_A"},
		{"api", "ARGON2_PEPPER"},
	} {
		if err := rec.Record(e.svc, e.name, "v", t0); err != nil {
			t.Fatal(err)
		}
	}
	all, err := rec.All()
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 3 {
		t.Fatalf("want 3, got %d", len(all))
	}
	// Expect (api/ARGON2_PEPPER), (api/POLARIS_SECRET_A), (panel/OIDC_CLIENT_SECRET).
	want := []string{"api/ARGON2_PEPPER", "api/POLARIS_SECRET_A", "panel/OIDC_CLIENT_SECRET"}
	for i, e := range all {
		got := e.Service + "/" + e.Name
		if got != want[i] {
			t.Errorf("order[%d]: want %s, got %s", i, want[i], got)
		}
	}
}
