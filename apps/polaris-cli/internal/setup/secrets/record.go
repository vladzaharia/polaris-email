package secrets

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

// DefaultRecordPath mirrors bin/_lib.sh's SECRETS_CREATED constant — the
// file lives next to .deploy-state.json at the repo root.
const DefaultRecordPath = "secrets.created.json"

// Entry is one (name, service, sha256_of_value, created_at) row in the
// append-only record. The sha256 lets an operator confirm which secret
// value landed without the value itself ever being on disk.
type Entry struct {
	Name      string    `json:"name"`
	Service   string    `json:"service"`
	SHA256    string    `json:"sha256_of_value"`
	CreatedAt time.Time `json:"created_at"`
}

// Recorder owns the on-disk secrets.created.json file. The append-only
// invariant is enforced by Record: existing entries are never rewritten.
//
// Concurrency: a process-local mutex guards reads + writes. The file is
// written atomically (temp + rename) and chmoded 0600 on every write.
// Cross-process concurrency is not protected — the cold-start flow is
// single-operator by design.
type Recorder struct {
	Path string
	mu   sync.Mutex
}

// NewRecorder builds a Recorder rooted at path. Pass DefaultRecordPath
// for the canonical location.
func NewRecorder(path string) *Recorder {
	if path == "" {
		path = DefaultRecordPath
	}
	return &Recorder{Path: path}
}

// Has reports whether (svc, name) already has an entry. An empty/missing
// record file counts as "no entries" — i.e. Has always returns false.
func (r *Recorder) Has(svc, name string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	entries, err := r.readLocked()
	if err != nil {
		return false
	}
	for _, e := range entries {
		if e.Service == svc && e.Name == name {
			return true
		}
	}
	return false
}

// Record appends a row for (svc, name, value). The value is hashed via
// sha256(value); the plain value is NOT persisted. createdAt may be the
// zero time, in which case time.Now().UTC() is used — exposing it as a
// parameter mostly so tests get deterministic output.
//
// Calling Record on a (svc, name) that already exists is a no-op (it
// returns nil without rewriting). The append-only invariant means the
// "first wins" semantic — if you need to rotate, write a new row with a
// fresh timestamp in a separate file (the upstream phase handles
// rotation).
func (r *Recorder) Record(svc, name, value string, createdAt time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	entries, err := r.readLocked()
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.Service == svc && e.Name == name {
			return nil // already recorded — append-only no-op.
		}
	}
	if createdAt.IsZero() {
		createdAt = time.Now().UTC()
	}
	entries = append(entries, Entry{
		Name:      name,
		Service:   svc,
		SHA256:    sha256Hex(value),
		CreatedAt: createdAt.UTC(),
	})
	return r.writeLocked(entries)
}

// Upsert replaces the existing (svc, name) row's sha256 with
// sha256(value), stamping createdAt as the rotation time. If no row
// exists it falls back to creating one. Used by the rotation flow —
// Record is append-only and "first wins", which is wrong semantically
// for a rotation (the sha must change to reflect the new value).
//
// The append-only invariant for first-time seeds remains intact:
// Upsert is only called by Rotate after the runner has verified the
// secret has been seeded at least once.
func (r *Recorder) Upsert(svc, name, value string, createdAt time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	entries, err := r.readLocked()
	if err != nil {
		return err
	}
	if createdAt.IsZero() {
		createdAt = time.Now().UTC()
	}
	replaced := false
	for i, e := range entries {
		if e.Service == svc && e.Name == name {
			entries[i] = Entry{
				Name:      name,
				Service:   svc,
				SHA256:    sha256Hex(value),
				CreatedAt: createdAt.UTC(),
			}
			replaced = true
			break
		}
	}
	if !replaced {
		entries = append(entries, Entry{
			Name:      name,
			Service:   svc,
			SHA256:    sha256Hex(value),
			CreatedAt: createdAt.UTC(),
		})
	}
	return r.writeLocked(entries)
}

// All returns a defensive copy of every entry. Sorted by (service,
// name, created_at) so callers (e.g. `secrets list`) get deterministic
// output.
func (r *Recorder) All() ([]Entry, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	entries, err := r.readLocked()
	if err != nil {
		return nil, err
	}
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].Service != entries[j].Service {
			return entries[i].Service < entries[j].Service
		}
		if entries[i].Name != entries[j].Name {
			return entries[i].Name < entries[j].Name
		}
		return entries[i].CreatedAt.Before(entries[j].CreatedAt)
	})
	return entries, nil
}

// readLocked decodes the on-disk record. A missing file is treated as
// an empty slice — the cold-start path may be the first thing to touch
// it. A malformed file is a hard error: silently overwriting it would
// destroy operator-visible state.
func (r *Recorder) readLocked() ([]Entry, error) {
	data, err := os.ReadFile(r.Path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("secrets: read %s: %w", r.Path, err)
	}
	// Be lenient about empty / `{}` files. Older shell pipelines may
	// have left an empty object behind.
	if len(data) == 0 || string(data) == "{}\n" || string(data) == "{}" {
		return nil, nil
	}
	var entries []Entry
	if err := json.Unmarshal(data, &entries); err != nil {
		return nil, fmt.Errorf("secrets: parse %s: %w", r.Path, err)
	}
	return entries, nil
}

// writeLocked atomically replaces the record file with the encoded
// entries. Mode 0600 is enforced on every write so a hand-edit can't
// silently widen permissions.
func (r *Recorder) writeLocked(entries []Entry) error {
	data, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		return fmt.Errorf("secrets: encode: %w", err)
	}
	data = append(data, '\n')
	dir := filepath.Dir(r.Path)
	if dir == "" {
		dir = "."
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("secrets: mkdir %s: %w", dir, err)
	}
	tmp, err := os.CreateTemp(dir, ".secrets-created-*.tmp")
	if err != nil {
		return fmt.Errorf("secrets: temp: %w", err)
	}
	cleanup := func() { _ = os.Remove(tmp.Name()) }
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("secrets: write: %w", err)
	}
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("secrets: chmod: %w", err)
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return fmt.Errorf("secrets: close: %w", err)
	}
	if err := os.Rename(tmp.Name(), r.Path); err != nil {
		cleanup()
		return fmt.Errorf("secrets: rename: %w", err)
	}
	return nil
}

// sha256Hex returns the lowercase hex digest of s. Helper to keep the
// "we only ever store the digest" invariant grep-able in one place.
func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}
