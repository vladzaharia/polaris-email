// Package rollback implements the three-tier setup rollback flow:
//
//   - deploy: shells out to `wrangler rollback` and re-stamps state.
//   - secret: reads a 1-deep .secrets.archive.json and re-pushes the
//     previously-rotated value to every service the secret was last
//     pushed to.
//   - phase: flips a Phase marker back to zero and prints the manual
//     remediation steps. NEVER auto-deletes CF resources — deleting a
//     D1 database (or R2 bucket, or KV namespace) would destroy
//     customer data, which is an explicit non-goal of automated
//     rollback. Operators are expected to clean up CF resources
//     themselves once they understand the blast radius.
//
// The package has no dependencies on the cmd/ tree; the cmd layer is a
// thin wrapper that wires these into cobra leaves.
package rollback

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// DefaultArchivePath mirrors the secrets.created.json convention — the
// archive lives next to the state file at the repo root, mode 0600.
const DefaultArchivePath = ".secrets.archive.json"

// ArchiveEntry is one previously-rotated (name, services, value) tuple.
// Only the most recent rotation per (name) is retained; new rotations
// supersede older ones. The plaintext value is intentionally on-disk
// (mode 0600) because a rollback necessarily needs the old value;
// archiving only the sha256 would make rollback impossible.
//
// Services is the ordered list of Workers the value was originally
// pushed to. RollbackSecret re-pushes to exactly this list so the
// rollback restores the same fan-out as the original deployment.
type ArchiveEntry struct {
	Name       string    `json:"name"`
	Services   []string  `json:"services"`
	Value      string    `json:"value"`
	SHA256     string    `json:"sha256_of_value"`
	ArchivedAt time.Time `json:"archived_at"`
}

// Archive owns the on-disk .secrets.archive.json file. Concurrency is
// limited to a process-local mutex; cross-process safety is the same
// single-operator-by-design contract as Recorder.
type Archive struct {
	Path string
	mu   sync.Mutex
}

// NewArchive returns an Archive rooted at path. Pass DefaultArchivePath
// for the canonical location.
func NewArchive(path string) *Archive {
	if path == "" {
		path = DefaultArchivePath
	}
	return &Archive{Path: path}
}

// Append records (name, services, value) as the latest archived
// rotation. If an entry for `name` already exists it is replaced —
// retention is 1-deep, so a newer rotation supersedes the older. The
// file is written atomically (temp + rename) with mode 0600.
func (a *Archive) Append(name string, services []string, value string) error {
	if name == "" {
		return fmt.Errorf("rollback: archive: secret name required")
	}
	if len(services) == 0 {
		return fmt.Errorf("rollback: archive: at least one service required for %s", name)
	}
	if value == "" {
		return fmt.Errorf("rollback: archive: value required for %s", name)
	}
	a.mu.Lock()
	defer a.mu.Unlock()

	entries, err := a.readLocked()
	if err != nil {
		return err
	}
	// 1-deep retention: drop any prior entry for the same name.
	out := entries[:0]
	for _, e := range entries {
		if e.Name == name {
			continue
		}
		out = append(out, e)
	}
	svcCopy := make([]string, len(services))
	copy(svcCopy, services)
	sort.Strings(svcCopy)
	out = append(out, ArchiveEntry{
		Name:       name,
		Services:   svcCopy,
		Value:      value,
		SHA256:     sha256Hex(value),
		ArchivedAt: time.Now().UTC(),
	})
	return a.writeLocked(out)
}

// Get returns the (services, value) pair for `name`. Returns
// (nil, "", false, nil) when no entry exists for the name — the caller
// is expected to surface a clear error to the operator.
func (a *Archive) Get(name string) (services []string, value string, ok bool, err error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	entries, err := a.readLocked()
	if err != nil {
		return nil, "", false, err
	}
	for _, e := range entries {
		if e.Name == name {
			out := make([]string, len(e.Services))
			copy(out, e.Services)
			return out, e.Value, true, nil
		}
	}
	return nil, "", false, nil
}

// All returns a defensive copy of every archive entry (without the
// plaintext value — callers that need the plaintext use Get).
func (a *Archive) All() ([]ArchiveEntry, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	entries, err := a.readLocked()
	if err != nil {
		return nil, err
	}
	out := make([]ArchiveEntry, len(entries))
	for i, e := range entries {
		clone := e
		clone.Value = "" // never hand out plaintext via All()
		out[i] = clone
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// readLocked decodes the on-disk archive. A missing file is "no
// archives yet" → nil slice. Malformed files are a hard error to keep
// destructive rewrites at bay.
func (a *Archive) readLocked() ([]ArchiveEntry, error) {
	data, err := os.ReadFile(a.Path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("rollback: read %s: %w", a.Path, err)
	}
	if len(data) == 0 {
		return nil, nil
	}
	var entries []ArchiveEntry
	if err := json.Unmarshal(data, &entries); err != nil {
		return nil, fmt.Errorf("rollback: parse %s: %w", a.Path, err)
	}
	return entries, nil
}

// writeLocked atomically replaces the archive with `entries`. Mode
// 0600 — the file holds plaintext secrets and must not be readable by
// other users on the box.
func (a *Archive) writeLocked(entries []ArchiveEntry) error {
	data, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		return fmt.Errorf("rollback: encode: %w", err)
	}
	data = append(data, '\n')
	dir := filepath.Dir(a.Path)
	if dir == "" {
		dir = "."
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("rollback: mkdir %s: %w", dir, err)
	}
	tmp, err := os.CreateTemp(dir, ".secrets-archive-*.tmp")
	if err != nil {
		return fmt.Errorf("rollback: temp: %w", err)
	}
	cleanup := func() { _ = os.Remove(tmp.Name()) }
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("rollback: write: %w", err)
	}
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("rollback: chmod: %w", err)
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return fmt.Errorf("rollback: close: %w", err)
	}
	if err := os.Rename(tmp.Name(), a.Path); err != nil {
		cleanup()
		return fmt.Errorf("rollback: rename: %w", err)
	}
	return nil
}

// sha256Hex mirrors the helper in secrets/record.go. Duplicated here
// rather than imported to keep the rollback package import-free of
// secrets — the dependency goes the other way (cmd wires both).
func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}
