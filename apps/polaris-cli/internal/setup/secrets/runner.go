package secrets

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/secrets/sources"
)

// Spec is one (name, target-service-list, generator) tuple describing
// one secret the runner must seed. The runner consults every Source in
// the chain before falling back to the Generator; if neither produces a
// value the secret is skipped (with a warning logged via Reporter).
//
// Services lists the Workers that must each receive `wrangler secret
// put`. POLARIS_SECRET_A goes to every Worker; ARGON2_PEPPER lands only
// on api; etc.
type Spec struct {
	// Name is the wrangler-side secret name (POLARIS_SECRET_A,
	// ARGON2_PEPPER, ...).
	Name string
	// Services is the ordered list of services to push to. The runner
	// pushes in order; failures on one service do not skip the rest.
	// Ignored when Shared=true and a SecretsStorePusher is configured:
	// the secret is pushed once to the account-level Secrets Store and
	// every Worker that lists it in `secrets_store_secrets` picks it up.
	Services []string
	// Generator mints a value when no Source has one. May be nil for
	// "must come from a source" secrets like OIDC_CLIENT_SECRET.
	Generator func() (string, error)
	// Optional flags the secret as best-effort: a Spec that has no
	// Source value AND no Generator is silently skipped, rather than
	// erroring. Used for OIDC_CLIENT_SECRET and the B2 anchor keys.
	Optional bool
	// Shared marks the secret as a candidate for the account-level
	// Cloudflare Secrets Store. When the cmd layer configures a
	// SecretsStorePusher (env POLARIS_SECRETS_STORE_ID is set), a
	// Shared spec pushes once to the store instead of N times via
	// `wrangler secret put`. Worker wrangler.jsonc files MUST list the
	// secret in `secrets_store_secrets` for the binding to materialise.
	//
	// Currently set for POLARIS_SECRET_A only (it lands on every
	// Worker). Per-Worker-scoped secrets (ARGON2_PEPPER, ANCHOR_*) gain
	// nothing from the store and stay on the per-Worker path.
	Shared bool
}

// Reporter receives per-secret progress events. Same shape as
// provision.Reporter but specialised to the (secret name, service)
// step grain.
type Reporter interface {
	Start(total int)
	Step(name, service string)
	StepDone(name, service string, err error)
	Done()
}

// Seed iterates `specs` and for each (spec, service) tuple:
//
//  1. Skips if the recorder already has a row.
//  2. Resolves the value from sources in order (first non-empty wins).
//  3. Falls back to spec.Generator() when no source has one.
//  4. Pushes via the Pusher.
//  5. Records the sha256 (never the value) in the recorder.
//
// The returned map is name → value for every secret the runner generated
// itself this run. The cmd leaf passes this back to the caller so the
// genesis-seal step (PR 7) can sign with POLARIS_SECRET_A without ever
// touching disk. Values resolved from a Source are NOT included — the
// caller can fetch them again from the same source if needed.
//
// On partial failure the function returns a multi-error citing every
// (name, service) pair that failed. The successful pushes already
// landed; re-running Seed is idempotent (the recorder skips the
// successful ones).
func Seed(
	ctx context.Context,
	specs []Spec,
	srcs []sources.Source,
	pusher Pusher,
	rec *Recorder,
	r Reporter,
) (map[string]string, error) {
	return SeedWithStore(ctx, specs, srcs, pusher, nil, rec, r)
}

// SeedWithStore is Seed plus an optional account-level Secrets Store
// pusher. Specs marked Shared=true push once to the store (when storePusher
// is non-nil), bypassing the per-Worker `wrangler secret put` path.
func SeedWithStore(
	ctx context.Context,
	specs []Spec,
	srcs []sources.Source,
	pusher Pusher,
	storePusher StorePusher,
	rec *Recorder,
	r Reporter,
) (map[string]string, error) {
	if pusher == nil {
		return nil, errors.New("secrets.Seed: nil Pusher")
	}
	if rec == nil {
		return nil, errors.New("secrets.Seed: nil Recorder")
	}
	if r == nil {
		r = nopReporter{}
	}

	// Count steps. Shared specs collapse to a single store push when
	// storePusher is configured; otherwise they fall through to the
	// per-service loop and count N.
	total := 0
	for _, s := range specs {
		if s.Shared && storePusher != nil {
			total++
			continue
		}
		total += len(s.Services)
	}
	r.Start(total)
	defer r.Done()

	out := map[string]string{}
	var failures []string

	// Cache resolved values across services so we only consult sources
	// once per secret name. POLARIS_SECRET_A is the same value across
	// every Worker by definition.
	resolved := map[string]string{}
	for _, s := range specs {
		val, fromGenerator, lookupErr := resolveValue(ctx, s, srcs, resolved)
		// We don't fail-fast on a missing optional — just skip its
		// services with a noted StepDone.
		if lookupErr != nil && !s.Optional {
			for _, svc := range s.Services {
				r.Step(s.Name, svc)
				r.StepDone(s.Name, svc, lookupErr)
				failures = append(failures, fmt.Sprintf("%s/%s: %v", svc, s.Name, lookupErr))
			}
			continue
		}
		if val == "" {
			// No source had it, no generator could mint it. Optional
			// secrets get a clean skip; non-optional ones already
			// errored above.
			for _, svc := range s.Services {
				r.Step(s.Name, svc)
				r.StepDone(s.Name, svc, nil) // skip cleanly
			}
			continue
		}
		if fromGenerator {
			out[s.Name] = val
		}

		// Shared + storePusher: account-level Secrets Store path.
		// The store row replaces every per-Worker `wrangler secret put`
		// call; Worker wrangler.jsonc `secrets_store_secrets` entries
		// surface the value as a binding at deploy time.
		if s.Shared && storePusher != nil {
			if err := ctx.Err(); err != nil {
				return out, err
			}
			r.Step(s.Name, "<store>")
			storeKey := "store:" + s.Name
			if rec.Has(storeKey, s.Name) {
				r.StepDone(s.Name, "<store>", nil) // idempotent skip
				continue
			}
			err := storePusher.PushStore(ctx, s.Name, val)
			r.StepDone(s.Name, "<store>", err)
			if err != nil {
				failures = append(failures, fmt.Sprintf("<store>/%s: %v", s.Name, err))
				continue
			}
			if recErr := rec.Record(storeKey, s.Name, val, time.Now().UTC()); recErr != nil {
				failures = append(failures, fmt.Sprintf("<store>/%s: record: %v", s.Name, recErr))
			}
			continue
		}

		for _, svc := range s.Services {
			if err := ctx.Err(); err != nil {
				return out, err
			}
			r.Step(s.Name, svc)
			if rec.Has(svc, s.Name) {
				r.StepDone(s.Name, svc, nil) // idempotent skip
				continue
			}
			err := pusher.Push(ctx, svc, s.Name, val)
			r.StepDone(s.Name, svc, err)
			if err != nil {
				failures = append(failures, fmt.Sprintf("%s/%s: %v", svc, s.Name, err))
				continue
			}
			if recErr := rec.Record(svc, s.Name, val, time.Now().UTC()); recErr != nil {
				failures = append(failures, fmt.Sprintf("%s/%s: record: %v", svc, s.Name, recErr))
			}
		}
	}

	if len(failures) > 0 {
		return out, fmt.Errorf("secrets: %d push failure(s):\n  %s",
			len(failures), strings.Join(failures, "\n  "))
	}
	return out, nil
}

// resolveValue walks the source chain (cached across specs) then falls
// back to the spec's generator. Returns (value, fromGenerator, error):
//
//   - value="" with err=nil + fromGenerator=false → optional skip path.
//   - value!="" with err=nil + fromGenerator=true → freshly minted; the
//     caller adds it to the returned map so genesis-seal can use it.
//   - value!="" with err=nil + fromGenerator=false → loaded from a source.
//   - err!=nil → source chain failed AND there's no generator. The
//     caller decides whether to escalate based on spec.Optional.
func resolveValue(
	ctx context.Context,
	s Spec,
	srcs []sources.Source,
	cache map[string]string,
) (string, bool, error) {
	if v, ok := cache[s.Name]; ok {
		return v, false, nil
	}
	for _, src := range srcs {
		v, err := src.Load(ctx, s.Name)
		if err != nil {
			// Source errored — log via the per-source mechanism in a
			// future PR. For now we just continue: a noisy source
			// should not block a working chain.
			continue
		}
		if v != "" {
			cache[s.Name] = v
			return v, false, nil
		}
	}
	if s.Generator != nil {
		v, err := s.Generator()
		if err != nil {
			return "", false, fmt.Errorf("generate %s: %w", s.Name, err)
		}
		if v == "" {
			return "", false, fmt.Errorf("generate %s: empty value", s.Name)
		}
		cache[s.Name] = v
		return v, true, nil
	}
	// No source value, no generator. The caller decides whether this is
	// fatal based on spec.Optional.
	if s.Optional {
		return "", false, nil
	}
	return "", false, fmt.Errorf("%s: no source produced a value and no generator is configured", s.Name)
}

// DefaultSpecs returns the canonical spec list that bin/bootstrap.sh
// phase-5 implements. Services is keyed off the same list the rest of
// the deploy flow uses, so adding a new Worker only requires adding it
// to the cmd-side service list — not to every spec individually.
//
// Most callers should construct their own slice off this (and adjust
// the .Services entries) so the test fixtures stay self-contained.
func DefaultSpecs(allWorkers []string) []Spec {
	return []Spec{
		{
			Name:      "POLARIS_SECRET_A",
			Services:  allWorkers,
			Generator: GenerateMasterSecret,
			// Shared across every Worker — collapses to a single
			// account-level Secrets Store push when the operator has
			// POLARIS_SECRETS_STORE_ID configured. Otherwise falls back
			// to N per-Worker `wrangler secret put` calls.
			Shared: true,
		},
		{
			Name:      "ARGON2_PEPPER",
			Services:  []string{"api"},
			Generator: GenerateArgon2Pepper,
		},
		{
			Name:      "ANCHOR_SIGNING_KEY",
			Services:  []string{"api"},
			Generator: GenerateAnchorSigningKey,
		},
		{
			Name:     "ANCHOR_S3_ACCESS_KEY_ID",
			Services: []string{"api"},
			Optional: true,
		},
		{
			Name:     "ANCHOR_S3_SECRET_ACCESS_KEY",
			Services: []string{"api"},
			Optional: true,
		},
		{
			Name:     "OIDC_CLIENT_SECRET",
			Services: []string{"panel"},
			Optional: true,
		},
	}
}

// nopReporter is the default when the caller passes nil.
type nopReporter struct{}

func (nopReporter) Start(int)                      {}
func (nopReporter) Step(string, string)            {}
func (nopReporter) StepDone(string, string, error) {}
func (nopReporter) Done()                          {}
