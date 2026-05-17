package rollback

import (
	"os"
	"path/filepath"
	"testing"
)

func TestArchive_AppendThenGet(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	a := NewArchive(filepath.Join(dir, ".secrets.archive.json"))

	if err := a.Append("POLARIS_SECRET_A", []string{"api", "out", "in"}, "old-value-v1"); err != nil {
		t.Fatalf("append: %v", err)
	}
	svcs, val, ok, err := a.Get("POLARIS_SECRET_A")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !ok {
		t.Fatal("want ok=true")
	}
	if val != "old-value-v1" {
		t.Errorf("value: got %q, want %q", val, "old-value-v1")
	}
	if len(svcs) != 3 {
		t.Errorf("services: got %v", svcs)
	}
}

func TestArchive_OneDeepRetention(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	a := NewArchive(filepath.Join(dir, "archive.json"))

	if err := a.Append("ARGON2_PEPPER", []string{"api"}, "old-1"); err != nil {
		t.Fatal(err)
	}
	if err := a.Append("ARGON2_PEPPER", []string{"api"}, "old-2"); err != nil {
		t.Fatal(err)
	}

	_, val, _, err := a.Get("ARGON2_PEPPER")
	if err != nil {
		t.Fatal(err)
	}
	if val != "old-2" {
		t.Errorf("retention should keep newest: got %q", val)
	}

	all, err := a.All()
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 1 {
		t.Fatalf("want 1 entry after 1-deep retention, got %d", len(all))
	}
}

func TestArchive_MultipleNamesCoexist(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	a := NewArchive(filepath.Join(dir, "archive.json"))

	if err := a.Append("POLARIS_SECRET_A", []string{"api"}, "v-a"); err != nil {
		t.Fatal(err)
	}
	if err := a.Append("ARGON2_PEPPER", []string{"api"}, "v-pep"); err != nil {
		t.Fatal(err)
	}
	all, err := a.All()
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 {
		t.Fatalf("want 2 entries, got %d", len(all))
	}
	for _, e := range all {
		if e.Value != "" {
			t.Errorf("All() leaked plaintext for %s", e.Name)
		}
	}
}

func TestArchive_GetMissing(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	a := NewArchive(filepath.Join(dir, "archive.json"))

	_, _, ok, err := a.Get("DOES_NOT_EXIST")
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Error("want ok=false for missing entry")
	}
}

func TestArchive_FileMode0600(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	path := filepath.Join(dir, "archive.json")
	a := NewArchive(path)
	if err := a.Append("X", []string{"api"}, "v"); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("file mode: got %o, want 0600", info.Mode().Perm())
	}
}

func TestArchive_RejectsEmptyName(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	a := NewArchive(filepath.Join(dir, "archive.json"))
	if err := a.Append("", []string{"api"}, "v"); err == nil {
		t.Error("want error on empty name")
	}
}

func TestArchive_RejectsEmptyServices(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	a := NewArchive(filepath.Join(dir, "archive.json"))
	if err := a.Append("X", nil, "v"); err == nil {
		t.Error("want error on no services")
	}
}

func TestArchive_RejectsEmptyValue(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	a := NewArchive(filepath.Join(dir, "archive.json"))
	if err := a.Append("X", []string{"api"}, ""); err == nil {
		t.Error("want error on empty value")
	}
}

func TestArchive_MissingFileReadsAsEmpty(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	a := NewArchive(filepath.Join(dir, "never-written.json"))
	entries, err := a.All()
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Errorf("missing file should read as 0 entries, got %d", len(entries))
	}
}

func TestArchive_PersistsAcrossInstances(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	p := filepath.Join(dir, "archive.json")

	a1 := NewArchive(p)
	if err := a1.Append("FOO", []string{"api"}, "v1"); err != nil {
		t.Fatal(err)
	}

	a2 := NewArchive(p)
	_, val, ok, err := a2.Get("FOO")
	if err != nil {
		t.Fatal(err)
	}
	if !ok || val != "v1" {
		t.Errorf("persistence: ok=%v val=%q", ok, val)
	}
}
