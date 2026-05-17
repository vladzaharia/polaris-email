package state

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

// Store is the typed handle on a single .deploy-state.json path. All IO is
// atomic — Write goes through a sibling tempfile and rename, and Lock uses
// a sibling .lock file (flock).
type Store struct {
	path string
}

// Open returns a *Store for the given path. The path does not need to
// exist yet; Read() will return a fresh Doc.
func Open(path string) *Store {
	return &Store{path: path}
}

// Path returns the configured on-disk path.
func (s *Store) Path() string { return s.path }

// Read loads and decodes the state file. If the file is missing it returns
// a freshly-stamped Doc at CurrentSchema. If the file contains an older
// schema, it is migrated forward in-memory (no write to disk happens
// here — call Write() to persist the migration).
func (s *Store) Read() (*Doc, error) {
	b, err := os.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			now := time.Now().UTC()
			return &Doc{
				SchemaVersion: CurrentSchema,
				CreatedAt:     now,
				UpdatedAt:     now,
			}, nil
		}
		return nil, fmt.Errorf("state: read %s: %w", s.path, err)
	}
	if len(b) == 0 {
		now := time.Now().UTC()
		return &Doc{
			SchemaVersion: CurrentSchema,
			CreatedAt:     now,
			UpdatedAt:     now,
		}, nil
	}
	var raw map[string]any
	if err := json.Unmarshal(b, &raw); err != nil {
		return nil, fmt.Errorf("state: decode %s: %w", s.path, err)
	}
	return migrateSchema(raw)
}

// Write atomically replaces the state file with d's contents. UpdatedAt is
// always stamped to time.Now().UTC(); CreatedAt is preserved (or stamped
// for first writes). The temp file lives in the same directory as the
// final path so rename(2) stays atomic on the same filesystem.
func (s *Store) Write(d *Doc) error {
	if d == nil {
		return fmt.Errorf("state: Write requires a non-nil Doc")
	}
	now := time.Now().UTC()
	if d.CreatedAt.IsZero() {
		d.CreatedAt = now
	}
	d.UpdatedAt = now
	d.SchemaVersion = CurrentSchema

	b, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return fmt.Errorf("state: marshal: %w", err)
	}
	b = append(b, '\n')

	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("state: mkdir %s: %w", dir, err)
	}
	tmp := s.path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("state: create temp: %w", err)
	}
	if _, err := f.Write(b); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return fmt.Errorf("state: write temp: %w", err)
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return fmt.Errorf("state: fsync temp: %w", err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("state: close temp: %w", err)
	}
	if err := os.Rename(tmp, s.path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("state: rename: %w", err)
	}
	return nil
}

// Marshal serializes d as JSON the same way Write would, but returns the
// bytes instead of touching disk. Useful for dry-run rendering.
func Marshal(d *Doc) ([]byte, error) {
	if d == nil {
		return nil, fmt.Errorf("state: Marshal requires a non-nil Doc")
	}
	return json.MarshalIndent(d, "", "  ")
}

// readFromReader exists so tests can feed in synthetic bytes without going
// through the filesystem.
func readFromReader(r io.Reader) (*Doc, error) {
	b, err := io.ReadAll(r)
	if err != nil {
		return nil, err
	}
	if len(b) == 0 {
		return &Doc{SchemaVersion: CurrentSchema}, nil
	}
	var raw map[string]any
	if err := json.Unmarshal(b, &raw); err != nil {
		return nil, err
	}
	return migrateSchema(raw)
}
