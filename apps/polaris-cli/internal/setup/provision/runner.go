// Package provision walks a plan.Plan and executes the Creates against
// Cloudflare via cfapi. The defining property is *resumability*: each
// successful create commits its record to .deploy-state.json atomically
// before moving on, so a kill -9 (or transient CF outage) mid-run
// resumes cleanly when the operator re-invokes `setup infra apply`.
//
// The runner is intentionally serial. Each create is fast enough
// (<10s) that parallelism would only buy noisy progress output, and
// serializing keeps the dependency-order contract simple: D1 → R2 →
// KV → Queues. (Nothing today actually depends on D1 being created
// before KV, but the order makes the progress bar feel predictable.)
//
// Failure handling: the first error bails. The state file already
// reflects every successful create up to the failure, so re-running
// `apply` picks up where the previous attempt stopped.
package provision

import (
	"context"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/cfapi"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/plan"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/state"
)

// Reporter receives per-step progress events. The TUI binds a Bubble
// Tea program to it; the plain --non-interactive path binds a simple
// io.Writer-backed implementation.
//
// All methods are best-effort — implementations must not panic. The
// runner never calls them after Done().
type Reporter interface {
	// Start signals the run is beginning. total counts the resources
	// the runner will attempt (Creates + Adopts).
	Start(total int)
	// Step is called immediately before a resource is touched.
	Step(kind, name string)
	// StepDone is called after the resource is recorded (or after the
	// adopt path stamps state). err non-nil signals the step failed —
	// the runner will return with an error shortly after.
	StepDone(kind, name string, err error)
	// Done signals the run completed (success or failure). Implementations
	// should flush any buffered output here.
	Done()
}

// PhaseName is the key used inside state.Doc.Phases for provision
// completion. Downstream phases (secrets, migrate) gate on this.
const PhaseName = "provision"

// ApplyOptions are extension knobs the orchestrator can pass to Apply
// without changing the core signature. Each field is optional;
// zero-values pick the documented default.
type ApplyOptions struct {
	// LogpushHTTPSink, when non-empty, makes the Logpush provision
	// sub-step skip the R2 auto-provision path and use the supplied
	// URL instead (e.g. https://in.logs.betterstack.com/?source_token=…).
	// Empty triggers the auto-R2 path: bucket → token → job, all
	// auto-created.
	LogpushHTTPSink string
}

// Apply walks p.Creates (and p.Adopt) and records each into the state
// store. The contract:
//
//   - p.Creates: call the matching cfapi Create*; record the returned
//     ID into state with Discovered=false; commit atomically.
//   - p.Adopt: skip the create entirely (resource already lives on CF);
//     record the live ID into state with Discovered=true; commit
//     atomically.
//   - p.Skips: no-op (resource already in state AND live).
//   - p.Drift: no-op (state says exists, live says no — leave the stale
//     record alone; operator must reconcile manually).
//
// On any failure the function returns immediately. The state file
// already holds the partial progress — re-invoking `apply` will diff
// fresh and resume.
//
// Apply is concurrency-safe in the sense that it acquires the state
// store's flock before any mutation; concurrent invocations on the
// same path serialize cleanly.
func Apply(ctx context.Context, client *cfapi.Client, store *state.Store, p *plan.Plan, r Reporter, opts ...ApplyOptions) error {
	var o ApplyOptions
	if len(opts) > 0 {
		o = opts[0]
	}
	if client == nil {
		return errors.New("provision: cfapi client is required")
	}
	if store == nil {
		return errors.New("provision: state store is required")
	}
	if p == nil {
		return errors.New("provision: plan is required")
	}
	if r == nil {
		r = nopReporter{}
	}

	// Acquire the state lock for the whole run. The bootstrap script
	// is single-operator so contention is rare, but the lock makes
	// concurrent CI runs an explicit error instead of a silently
	// interleaved state file.
	unlock, err := store.Lock(true)
	if err != nil {
		return fmt.Errorf("provision: lock state: %w", err)
	}
	defer func() { _ = unlock() }()

	doc, err := store.Read()
	if err != nil {
		return fmt.Errorf("provision: read state: %w", err)
	}
	ensureMaps(doc)

	total := len(p.Creates) + len(p.Adopt)
	r.Start(total)
	defer r.Done()

	// Walk in dependency-safe order. The diff path already sorts
	// p.Creates by (Kind, Name), but we re-bucket here so the Adopt
	// entries get the same kind-ordered walk.
	type stepFn func(context.Context, plan.Entry) error
	steps := []struct {
		entries []plan.Entry
		fn      stepFn
	}{
		{filterByKind(p.Creates, plan.KindD1), createD1Step(client, doc)},
		{filterByKind(p.Adopt, plan.KindD1), adoptD1Step(doc)},
		{filterByKind(p.Creates, plan.KindR2), createR2Step(client, doc)},
		{filterByKind(p.Adopt, plan.KindR2), adoptR2Step(doc)},
		{filterByKind(p.Creates, plan.KindKV), createKVStep(client, doc)},
		{filterByKind(p.Adopt, plan.KindKV), adoptKVStep(doc)},
		{filterByKind(p.Creates, plan.KindQueue), createQueueStep(client, doc)},
		{filterByKind(p.Adopt, plan.KindQueue), adoptQueueStep(doc)},
	}

	for _, s := range steps {
		for _, e := range s.entries {
			if err := ctx.Err(); err != nil {
				return err
			}
			r.Step(string(e.Kind), e.Name)
			err := s.fn(ctx, e)
			r.StepDone(string(e.Kind), e.Name, err)
			if err != nil {
				return fmt.Errorf("provision: %s %s: %w", e.Kind, e.Name, err)
			}
			// Commit after every successful step. This is the
			// resumability guarantee — kill -9 here loses nothing
			// because the latest state is already on disk.
			if err := store.Write(doc); err != nil {
				return fmt.Errorf("provision: persist state after %s %s: %w", e.Kind, e.Name, err)
			}
		}
	}

	// Logpush composes R2 bucket + token + job. Runs unconditionally
	// (idempotent — guards on state + live presence) after the main
	// resource loop, since the Logpush job needs the polaris-email-logs
	// bucket to already exist. Failure is non-fatal at provision time —
	// observability auto-config is a "nice to have", not a launch
	// blocker. We surface the error to the reporter but advance the
	// phase anyway.
	r.Step("logpush", "polaris-email-workers")
	if err := ProvisionLogpush(ctx, client, doc, o.LogpushHTTPSink); err != nil {
		r.StepDone("logpush", "polaris-email-workers", err)
		// Log + continue; operator can `polaris-email setup infra apply`
		// again to retry just this step.
	} else {
		r.StepDone("logpush", "polaris-email-workers", nil)
		if err := store.Write(doc); err != nil {
			return fmt.Errorf("provision: persist state after logpush: %w", err)
		}
	}

	// Mark the phase complete. Downstream phases (secrets, migrate) read
	// this to gate on a successful provision.
	if doc.Phases == nil {
		doc.Phases = map[string]state.Phase{}
	}
	doc.Phases[PhaseName] = state.Phase{
		CompletedAt: time.Now().UTC(),
	}
	if err := store.Write(doc); err != nil {
		return fmt.Errorf("provision: persist phase completion: %w", err)
	}
	return nil
}

// filterByKind returns the subset of entries matching k. Tiny helper
// that keeps the steps slice in Apply() readable.
func filterByKind(entries []plan.Entry, k plan.ResourceKind) []plan.Entry {
	var out []plan.Entry
	for _, e := range entries {
		if e.Kind == k {
			out = append(out, e)
		}
	}
	return out
}

// ensureMaps lazily allocates the per-kind maps so the per-step helpers
// can assume non-nil. Safe to call repeatedly.
func ensureMaps(d *state.Doc) {
	if d.D1 == nil {
		d.D1 = map[string]state.Resource{}
	}
	if d.R2 == nil {
		d.R2 = map[string]state.R2Bucket{}
	}
	if d.R2Tokens == nil {
		d.R2Tokens = map[string]state.R2Token{}
	}
	if d.KV == nil {
		d.KV = map[string]state.Resource{}
	}
	if d.Queues == nil {
		d.Queues = map[string]state.Resource{}
	}
	if d.LogpushJobs == nil {
		d.LogpushJobs = map[string]state.LogpushJob{}
	}
}

// nopReporter is the default when the caller passes nil.
type nopReporter struct{}

func (nopReporter) Start(int)                      {}
func (nopReporter) Step(string, string)            {}
func (nopReporter) StepDone(string, string, error) {}
func (nopReporter) Done()                          {}

// PlainReporter writes one line per step to w. Used in --non-interactive
// mode and CI; the TUI reporter (cmd/) is a Bubble Tea program.
type PlainReporter struct {
	W       io.Writer
	current int
	total   int
}

// NewPlainReporter constructs a PlainReporter writing to w.
func NewPlainReporter(w io.Writer) *PlainReporter { return &PlainReporter{W: w} }

// Start records the total step count for the "1/N" prefix.
func (p *PlainReporter) Start(total int) {
	p.total = total
	p.current = 0
	if p.W != nil && total > 0 {
		fmt.Fprintf(p.W, "provision: applying %d resource(s)\n", total)
	}
}

// Step prints the in-flight resource. We don't flush here — the step
// completes fast enough that the line lands together with the result.
func (p *PlainReporter) Step(kind, name string) {
	p.current++
	if p.W == nil {
		return
	}
	fmt.Fprintf(p.W, "  [%d/%d] %s %s ... ", p.current, p.total, kind, name)
}

// StepDone closes the line with "done" or "FAILED: <err>".
func (p *PlainReporter) StepDone(_, _ string, err error) {
	if p.W == nil {
		return
	}
	if err != nil {
		fmt.Fprintf(p.W, "FAILED: %v\n", err)
		return
	}
	fmt.Fprintln(p.W, "done")
}

// Done emits a final newline so the next command output isn't glued to
// the last step line. Total step count is already printed by Start.
func (p *PlainReporter) Done() {
	if p.W == nil {
		return
	}
	if p.total > 0 {
		fmt.Fprintln(p.W, "provision: complete")
	}
}
