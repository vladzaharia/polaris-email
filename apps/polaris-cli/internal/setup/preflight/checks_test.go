package preflight

import (
	"context"
	"strings"
	"testing"
)

func TestRun_PassWarnFailCounts(t *testing.T) {
	t.Parallel()
	checks := []Check{
		{Name: "a", Required: true, Run: func(ctx context.Context) Result { return pass("ok") }},
		{Name: "b", Required: true, Run: func(ctx context.Context) Result { return warn("eh", "fix-b") }},
		{Name: "c", Required: true, Run: func(ctx context.Context) Result { return fail("nope", "fix-c") }},
	}
	results, sum := Run(context.Background(), checks, false)
	if len(results) != 3 {
		t.Fatalf("want 3 results, got %d", len(results))
	}
	if sum.Pass != 1 || sum.Warn != 1 || sum.Fail != 1 {
		t.Errorf("summary: want 1/1/1, got %+v", sum)
	}
	if !sum.HasFail() {
		t.Error("HasFail() should be true with a single FAIL")
	}
}

func TestRun_RequiredOnlyFiltersOptional(t *testing.T) {
	t.Parallel()
	checks := []Check{
		{Name: "required", Required: true, Run: func(ctx context.Context) Result { return pass("yes") }},
		{Name: "optional", Required: false, Run: func(ctx context.Context) Result { return fail("should-be-skipped", "") }},
	}
	results, sum := Run(context.Background(), checks, true)
	if len(results) != 1 {
		t.Fatalf("required-only: want 1 result, got %d", len(results))
	}
	if results[0].Name != "required" {
		t.Errorf("kept the wrong check: %s", results[0].Name)
	}
	if sum.Fail != 0 {
		t.Errorf("optional check should be skipped; sum=%+v", sum)
	}
}

func TestRun_PanicInCheckBecomesFail(t *testing.T) {
	t.Parallel()
	checks := []Check{
		{Name: "panic", Required: true, Run: func(ctx context.Context) Result { panic("boom") }},
	}
	results, sum := Run(context.Background(), checks, false)
	if len(results) != 1 || results[0].Status != StatusFail {
		t.Fatalf("want one FAIL result from panic, got %+v", results)
	}
	if sum.Fail != 1 {
		t.Errorf("panic should count as a fail, got %+v", sum)
	}
	if !strings.Contains(results[0].Detail, "panic") {
		t.Errorf("Detail should mention panic: %q", results[0].Detail)
	}
}

func TestRun_NilRunFnIsFail(t *testing.T) {
	t.Parallel()
	checks := []Check{{Name: "nil-fn", Required: true, Run: nil}}
	results, sum := Run(context.Background(), checks, false)
	if sum.Fail != 1 || results[0].Status != StatusFail {
		t.Errorf("nil Run should produce a fail, got %+v / %+v", results, sum)
	}
}

func TestRenderText_ContainsExpectedTokens(t *testing.T) {
	t.Parallel()
	results := []CheckResult{
		{Name: "ok-thing", Result: pass("ok-detail")},
		{Name: "warn-thing", Result: warn("warn-detail", "warn-fix")},
		{Name: "fail-thing", Result: fail("fail-detail", "fail-fix")},
	}
	sum := Summary{Pass: 1, Warn: 1, Fail: 1}
	var b strings.Builder
	RenderText(&b, results, sum)
	out := b.String()
	for _, want := range []string{
		"  ok   ok-thing",
		"  warn warn-thing",
		"  FAIL fail-thing",
		"fail-fix",
		"warn-fix",
		"preflight failed",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("RenderText missing %q\n--- output ---\n%s", want, out)
		}
	}
}
