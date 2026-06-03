package listeners

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// LoadSettings reads a persisted Settings snapshot from path, overlaying
// it onto base so that fields ABSENT from an older on-disk file keep
// base's value (forward-compatibility when new Settings fields are
// added). Returns (merged, found, err); found is false when the file
// does not exist (first boot) and base is returned unchanged.
//
// Precedence is "persisted wins" (Option A): the panel/server is
// authoritative for these fields, so a value the bridge already applied
// overrides the env-derived boot default.
func LoadSettings(path string, base Settings) (Settings, bool, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return base, false, nil
		}
		return base, false, fmt.Errorf("read settings %s: %w", path, err)
	}
	merged := base
	if err := json.Unmarshal(b, &merged); err != nil {
		return base, false, fmt.Errorf("decode settings %s: %w", path, err)
	}
	return merged, true, nil
}

// SaveSettings writes a Settings snapshot to path atomically (temp file +
// rename, mode 0600) so a crash mid-write can't leave a truncated file
// that would fail to decode on the next boot.
func SaveSettings(path string, s Settings) error {
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return fmt.Errorf("encode settings: %w", err)
	}
	return atomicWriteFile(path, b, 0o600)
}

// atomicWriteFile writes data to a sibling temp file then renames it over
// path. rename(2) is atomic within a filesystem, so readers see either
// the old or the new file, never a partial one.
func atomicWriteFile(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", dir, err)
	}
	tmp, err := os.CreateTemp(dir, filepath.Base(path)+".tmp-*")
	if err != nil {
		return fmt.Errorf("create temp in %s: %w", dir, err)
	}
	tmpName := tmp.Name()
	// Best-effort cleanup if we bail before the rename.
	defer func() { _ = os.Remove(tmpName) }()

	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write temp: %w", err)
	}
	if err := tmp.Chmod(perm); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("chmod temp: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("rename %s → %s: %w", tmpName, path, err)
	}
	return nil
}
