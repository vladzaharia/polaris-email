// Package preflight ports bin/preflight.sh to typed Go. Every prerequisite
// is a [Check] with a single Run function returning a [Result]; the
// [Runner] aggregates results and decides the exit code.
//
// Design parity with the shell script is load-bearing — the `make parity`
// CI gate diffs the two flows. Adding a new check here also requires
// touching bin/preflight.sh (or vice versa) so the two stay in sync.
package preflight

import "context"

// Status is the pass/warn/fail tri-state every check produces.
type Status string

const (
	// StatusPass — the check ran and the prerequisite is satisfied.
	StatusPass Status = "pass"
	// StatusWarn — the check ran and revealed a soft issue. Runs that
	// have only warns (no fails) exit zero unless `--required-only`
	// flips warns into fails.
	StatusWarn Status = "warn"
	// StatusFail — the check ran and the prerequisite is missing or
	// broken. Any single fail causes the runner to exit non-zero.
	StatusFail Status = "fail"
)

// Check is one preflight assertion.
//
// Name is the operator-facing label rendered in the table output.
//
// Required=true makes the check eligible for `--required-only`; when
// that flag is set, non-required checks are skipped entirely (the shell
// equivalent of POLARIS_REQUIRE_DOCKER gating).
//
// Description is a short sentence shown in `-o json` output and the
// `--help` text for the preflight command.
//
// Run executes the check. It must not panic; failures should be encoded
// as a [Result] with [StatusFail] and a Fix line. Long-running checks
// should respect the context deadline.
type Check struct {
	Name        string
	Required    bool
	Description string
	Run         func(ctx context.Context) Result
}

// Result is the outcome of running a single [Check].
//
// Status is one of [StatusPass]/[StatusWarn]/[StatusFail].
//
// Detail is a one-line operator-facing message describing what was
// found (e.g. "pnpm 9.7.0" on pass, or "pnpm not in PATH" on fail).
//
// Fix is the remediation line shown after a FAIL (mirroring the shell
// script's `fix:` suffix). Empty on pass.
type Result struct {
	Status Status `json:"status"`
	Detail string `json:"detail,omitempty"`
	Fix    string `json:"fix,omitempty"`
}

// pass is a convenience builder for [StatusPass] with a detail string.
func pass(detail string) Result { return Result{Status: StatusPass, Detail: detail} }

// warn is a convenience builder for [StatusWarn]. Fix is optional.
func warn(detail, fix string) Result { return Result{Status: StatusWarn, Detail: detail, Fix: fix} }

// fail is a convenience builder for [StatusFail].
func fail(detail, fix string) Result { return Result{Status: StatusFail, Detail: detail, Fix: fix} }
