package secrets

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/secrets/sources"
)

// Format identifies the encoding shape for a rotated secret. The
// runner uses this to pick a new generator that preserves byte-shape
// (so wrangler-side validators that read base64 don't choke on a
// rotated hex value).
type Format int

const (
	// FormatUnknown means the runner falls back to base64 standard
	// (matches POLARIS_SECRET_A's historical shape).
	FormatUnknown Format = iota
	// FormatBase64Raw is unpadded standard base64. POLARIS_SECRET_A,
	// ANCHOR_SIGNING_KEY use this.
	FormatBase64Raw
	// FormatHexLower is lowercase hex. ARGON2_PEPPER uses this.
	FormatHexLower
)

// RotateOptions gates Rotate.
type RotateOptions struct {
	// Sources is the source chain consulted to read the CURRENT
	// value (which gets archived). Required — without a way to read
	// the existing value we cannot archive the rollback target.
	Sources []sources.Source
	// Pusher pushes the NEW value to every recorded service.
	// Optional: defaults to WranglerPusher{}.
	Pusher Pusher
	// Recorder owns secrets.created.json. Required so we know which
	// services hold the secret (and to re-stamp the new sha256).
	Recorder *Recorder
	// Archive holds rollback values. Optional: when nil, the rotation
	// proceeds without writing a rollback archive (the operator
	// explicitly opted out).
	Archive RotateArchiver
	// Reporter receives per-service progress events. Optional.
	Reporter Reporter
}

// RotateArchiver is the minimum surface Rotate needs from a
// .secrets.archive.json holder. The full type lives in
// internal/setup/rollback; declaring the interface here avoids a
// circular import (rollback imports secrets for Pusher / Reporter).
type RotateArchiver interface {
	Append(name string, services []string, value string) error
}

// Rotate executes the 5-step rotation pipeline for a single secret:
//
//  1. Read the current value via the source chain.
//  2. Generate a new value with the same byte-shape (base64 vs hex).
//  3. Append the OLD value to the archive (1-deep, supersedes prior).
//  4. Push the NEW value to every service the recorder lists for `name`.
//  5. Re-stamp secrets.created.json with the new sha256.
//
// If the source chain has no current value the rotation fails fast —
// without an archived "previous" we'd lose the rollback target. The
// operator is expected to seed the source chain (env var, vault) with
// the current value before rotating.
//
// On partial failure (some services push the new value, others fail)
// the returned error cites every failed (svc, name) pair. The
// archive write has already happened by then, so re-running Rotate
// will push the SAME new value to the failed services.
func Rotate(ctx context.Context, name string, opts RotateOptions) error {
	if name == "" {
		return fmt.Errorf("secrets: rotate: name required")
	}
	if opts.Recorder == nil {
		return fmt.Errorf("secrets: rotate: recorder required")
	}
	if len(opts.Sources) == 0 {
		return fmt.Errorf("secrets: rotate: at least one source required to read the current value (you must seed the env or vault before rotating)")
	}
	pusher := opts.Pusher
	if pusher == nil {
		pusher = WranglerPusher{}
	}
	rep := opts.Reporter

	// 1. Read current value from sources.
	current := ""
	for _, src := range opts.Sources {
		v, err := src.Load(ctx, name)
		if err != nil {
			continue
		}
		if v != "" {
			current = v
			break
		}
	}
	if current == "" {
		return fmt.Errorf("secrets: rotate %s: no source produced the current value (cannot archive without the old value)", name)
	}

	// 2. Determine which services hold this secret today.
	allEntries, err := opts.Recorder.All()
	if err != nil {
		return fmt.Errorf("secrets: rotate %s: read recorder: %w", name, err)
	}
	var services []string
	seen := map[string]struct{}{}
	for _, e := range allEntries {
		if e.Name != name {
			continue
		}
		if _, ok := seen[e.Service]; ok {
			continue
		}
		seen[e.Service] = struct{}{}
		services = append(services, e.Service)
	}
	if len(services) == 0 {
		return fmt.Errorf("secrets: rotate %s: no services recorded for this secret — run `setup infra secrets seed` first", name)
	}

	format := detectFormat(current)
	newValue, err := generateMatching(format, len(current))
	if err != nil {
		return fmt.Errorf("secrets: rotate %s: generate: %w", name, err)
	}

	// 3. Archive the OLD value (1-deep). Done BEFORE the push so a
	//    crash mid-push still leaves the archive intact and the
	//    operator can RollbackSecret to restore.
	if opts.Archive != nil {
		if err := opts.Archive.Append(name, services, current); err != nil {
			return fmt.Errorf("secrets: rotate %s: archive: %w", name, err)
		}
	}

	// 4. Push the NEW value to every service.
	if rep != nil {
		rep.Start(len(services))
		defer rep.Done()
	}
	var failures []string
	for _, svc := range services {
		if err := ctx.Err(); err != nil {
			return err
		}
		if rep != nil {
			rep.Step(name, svc)
		}
		err := pusher.Push(ctx, svc, name, newValue)
		if rep != nil {
			rep.StepDone(name, svc, err)
		}
		if err != nil {
			failures = append(failures, fmt.Sprintf("%s/%s: %v", svc, name, err))
			continue
		}
		// 5. Re-stamp the recorder. Upsert replaces the row's sha to
		//    reflect the NEW value.
		if err := opts.Recorder.Upsert(svc, name, newValue, time.Now().UTC()); err != nil {
			failures = append(failures, fmt.Sprintf("%s/%s: record: %v", svc, name, err))
		}
	}
	if len(failures) > 0 {
		return fmt.Errorf("secrets: rotate %s: %d failure(s):\n  %s",
			name, len(failures), joinFailures(failures))
	}
	return nil
}

// detectFormat is best-effort: hex digits are also valid base64, so
// the only reliable disambiguator is "all-lowercase hex of even
// length" → hex; everything else → base64 standard.
func detectFormat(v string) Format {
	if v == "" {
		return FormatUnknown
	}
	if len(v)%2 != 0 {
		return FormatBase64Raw
	}
	for _, c := range v {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return FormatBase64Raw
		}
	}
	return FormatHexLower
}

// generateMatching mints a fresh secret with the same byte-shape as
// the provided exemplar length. Unknown formats default to 32 random
// bytes encoded as base64-raw (matches POLARIS_SECRET_A).
func generateMatching(f Format, encodedLen int) (string, error) {
	switch f {
	case FormatHexLower:
		raw := encodedLen / 2
		if raw < 16 {
			raw = 16
		}
		b := make([]byte, raw)
		if _, err := rand.Read(b); err != nil {
			return "", err
		}
		return hex.EncodeToString(b), nil
	case FormatBase64Raw, FormatUnknown:
		raw := (encodedLen * 6) / 8
		if raw < 32 {
			raw = 32
		}
		b := make([]byte, raw)
		if _, err := rand.Read(b); err != nil {
			return "", err
		}
		return base64.RawStdEncoding.EncodeToString(b), nil
	}
	return "", fmt.Errorf("secrets: rotate: unhandled format %d", f)
}

func joinFailures(ss []string) string {
	out := ""
	for i, s := range ss {
		if i > 0 {
			out += "\n  "
		}
		out += s
	}
	return out
}
