// Package migrate is the Go port of phase 4 of bin/bootstrap.sh: shell
// out to `wrangler d1 migrations apply <db> --remote` and capture the
// highest-applied migration filename into the state ledger.
//
// The wrapper is intentionally thin — wrangler owns the migration
// engine, the SQL diff, and the D1 contract. We add value by:
//
//  1. Parsing the human-readable output for the highest applied
//     filename so the state file knows what's live.
//  2. Returning a typed Result so the cmd leaf can render a tidy
//     summary (count + latest filename) instead of dumping wrangler's
//     full output.
//  3. Recording the phase completion in the state ledger so subsequent
//     runs can short-circuit ("migrate" phase already done at sha=X).
package migrate

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/state"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/wrangler"
)

// PhaseName is the key written into state.Doc.Phases when Apply succeeds.
// Mirrors provision.PhaseName so the convention is consistent across
// every cold-start phase.
const PhaseName = "migrate"

// Result captures the outcome of a single `wrangler d1 migrations apply`
// invocation. Latest is the filename of the highest applied migration
// (e.g. "0021_anchor_table.sql") or "" if no migrations were applied
// because the schema was already current.
type Result struct {
	// Applied is the count of migrations the run actually executed.
	// Zero means "schema was already current".
	Applied int
	// Latest is the filename of the highest-numbered migration applied
	// in this run, or — when Applied is zero — the highest migration
	// the database already had.
	Latest string
	// Stdout is the raw wrangler stdout for debugging. The cmd leaf
	// shows this on --verbose; ordinary runs print the structured
	// summary above.
	Stdout string
}

// Runner abstracts the wrangler invocation so tests can swap in a fake.
type Runner interface {
	Run(ctx context.Context, args ...string) (*wrangler.Result, error)
}

// wranglerRunner is the production Runner.
type wranglerRunner struct{}

// Run implements Runner.
func (wranglerRunner) Run(ctx context.Context, args ...string) (*wrangler.Result, error) {
	return wrangler.Run(ctx, args...)
}

// Apply runs `wrangler d1 migrations apply <dbName>` against the configured
// account. `remote` toggles --remote vs --local (cold-start always passes
// true). `store` is the state ledger; on success we stamp Phases["migrate"]
// to the run's completion time.
func Apply(ctx context.Context, dbName string, remote bool, store *state.Store) (*Result, error) {
	return ApplyWith(ctx, dbName, remote, store, wranglerRunner{})
}

// ApplyWith is the lower-level entry point that lets the caller inject a
// fake wrangler Runner. The cmd leaf uses Apply; tests use ApplyWith.
func ApplyWith(ctx context.Context, dbName string, remote bool, store *state.Store, runner Runner) (*Result, error) {
	if dbName == "" {
		return nil, fmt.Errorf("migrate: db name required")
	}
	if runner == nil {
		runner = wranglerRunner{}
	}

	args := []string{"d1", "migrations", "apply", dbName}
	if remote {
		args = append(args, "--remote")
	} else {
		args = append(args, "--local")
	}

	r, err := runner.Run(ctx, args...)
	if err != nil {
		// wrangler.Run already wraps the stderr in the error; surface
		// our own prefix so it's clear which phase failed.
		return nil, fmt.Errorf("migrate apply %s: %w", dbName, err)
	}
	res := parseOutput(r.Stdout)

	// Stamp the phase in state. We do this even when Applied==0 — the
	// fact that the migration command was successfully invoked is
	// itself a signal we want to record.
	if store != nil {
		if err := stampPhase(store, res); err != nil {
			return res, fmt.Errorf("migrate: record phase: %w", err)
		}
	}
	return res, nil
}

// stampPhase writes the migrate phase entry into the state document.
// We deliberately do not include the migration filename in state.Phase
// today — the schema would need extending. Latest is logged + returned
// in the Result so callers can surface it.
func stampPhase(store *state.Store, _ *Result) error {
	unlock, err := store.Lock(true)
	if err != nil {
		return err
	}
	defer func() { _ = unlock() }()

	doc, err := store.Read()
	if err != nil {
		return err
	}
	if doc.Phases == nil {
		doc.Phases = map[string]state.Phase{}
	}
	doc.Phases[PhaseName] = state.Phase{CompletedAt: time.Now().UTC()}
	return store.Write(doc)
}

// wrangler 4.x prints lines like:
//
//	"🚣 Applied 3 migrations: 0019_..., 0020_..., 0021_..."
//	"🌀 Mapping SQL input into an array of statements"
//	"┌──────────────────────────┬────────────┐"
//	"│ name                     │ status     │"
//	"├──────────────────────────┼────────────┤"
//	"│ 0019_outbound_tracking   │ ✅          │"
//	...
//
// Older 4.0-era versions emit a less decorated form. We try the
// "Applied N migrations" line first (most reliable), then fall back to
// scanning the table for filenames.
var (
	appliedCountRE = regexp.MustCompile(`Applied (\d+) migration`)
	migrationFileRE = regexp.MustCompile(`(\d{4,}_[a-zA-Z0-9_.-]+\.sql)`)
)

// parseOutput extracts (Applied, Latest) from the wrangler stdout.
// Returns an empty Result on unparseable output rather than erroring —
// the caller can still observe Stdout for debugging.
func parseOutput(out []byte) *Result {
	r := &Result{Stdout: string(out)}
	if m := appliedCountRE.FindSubmatch(out); len(m) == 2 {
		fmt.Sscanf(string(m[1]), "%d", &r.Applied)
	}
	// Find every migration filename in the output, return the
	// lexicographically-highest (filenames are zero-padded so this is
	// equivalent to numeric order).
	matches := migrationFileRE.FindAllString(string(out), -1)
	if len(matches) > 0 {
		latest := matches[0]
		for _, m := range matches {
			if m > latest {
				latest = m
			}
		}
		r.Latest = latest
	}
	// Detect "no migrations to apply" patterns. wrangler prints
	// "No migrations to apply!" on a current schema.
	if strings.Contains(r.Stdout, "No migrations to apply") {
		r.Applied = 0
	}
	return r
}
