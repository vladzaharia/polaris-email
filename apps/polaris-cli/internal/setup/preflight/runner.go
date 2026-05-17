package preflight

import (
	"context"
	"fmt"
	"io"
)

// CheckResult pairs a [Check] with its [Result] for rendering and JSON
// emission.
type CheckResult struct {
	Name     string `json:"name"`
	Required bool   `json:"required"`
	Result
}

// Summary aggregates a slice of [CheckResult] into counts. The runner
// returns a Summary alongside the raw results so callers can do their
// own rendering or assertions without re-scanning the slice.
type Summary struct {
	Pass int `json:"pass"`
	Warn int `json:"warn"`
	Fail int `json:"fail"`
}

// HasFail reports whether any check failed (the runner's exit signal).
func (s Summary) HasFail() bool { return s.Fail > 0 }

// Run executes every check in order and returns the per-check results
// plus a summary.
//
// requiredOnly=true filters the list to checks with Required=true
// *before* running, matching the shell script's behavior of skipping
// optional probes when the operator wants a fast-path gate (e.g. CI
// noise-reduction).
//
// Each check is run sequentially — preflight is fast (~seconds total)
// and serialized output keeps the rendered table deterministic. If you
// add a slow network check, gate it behind a context deadline rather
// than parallelizing.
func Run(ctx context.Context, checks []Check, requiredOnly bool) ([]CheckResult, Summary) {
	out := make([]CheckResult, 0, len(checks))
	var sum Summary
	for _, c := range checks {
		if requiredOnly && !c.Required {
			continue
		}
		// Panic-guard: a misbehaving check should not take down the runner.
		res := safeRun(ctx, c)
		out = append(out, CheckResult{Name: c.Name, Required: c.Required, Result: res})
		switch res.Status {
		case StatusPass:
			sum.Pass++
		case StatusWarn:
			sum.Warn++
		case StatusFail:
			sum.Fail++
		}
	}
	return out, sum
}

// safeRun invokes c.Run with a recover() so a panicking check is turned
// into a clean [StatusFail] result. Without this a buggy probe would
// abort the entire preflight pass.
func safeRun(ctx context.Context, c Check) (res Result) {
	defer func() {
		if r := recover(); r != nil {
			res = fail(fmt.Sprintf("check panicked: %v", r), "report this as a polaris-email bug")
		}
	}()
	if c.Run == nil {
		return fail("check has no Run function (programming error)", "report this as a polaris-email bug")
	}
	return c.Run(ctx)
}

// RenderText writes the shell-script-style "  ok / FAIL / warn  <name>"
// lines for the given results. Used as the default `-o table` form so a
// side-by-side diff against bin/preflight.sh is mechanical.
func RenderText(w io.Writer, results []CheckResult, sum Summary) {
	for _, r := range results {
		switch r.Status {
		case StatusPass:
			fmt.Fprintf(w, "  ok   %s", r.Name)
			if r.Detail != "" {
				fmt.Fprintf(w, " (%s)", r.Detail)
			}
			fmt.Fprintln(w)
		case StatusWarn:
			fmt.Fprintf(w, "  warn %s", r.Name)
			if r.Detail != "" {
				fmt.Fprintf(w, " — %s", r.Detail)
			}
			fmt.Fprintln(w)
			if r.Fix != "" {
				fmt.Fprintf(w, "       fix: %s\n", r.Fix)
			}
		case StatusFail:
			fmt.Fprintf(w, "  FAIL %s", r.Name)
			if r.Detail != "" {
				fmt.Fprintf(w, " — %s", r.Detail)
			}
			fmt.Fprintln(w)
			if r.Fix != "" {
				fmt.Fprintf(w, "       fix: %s\n", r.Fix)
			}
		}
	}
	fmt.Fprintln(w)
	if sum.HasFail() {
		fmt.Fprintln(w, "preflight failed — address the FAIL lines above.")
	} else if sum.Warn > 0 {
		fmt.Fprintf(w, "preflight OK with %d warning(s).\n", sum.Warn)
	} else {
		fmt.Fprintln(w, "preflight OK.")
	}
}

