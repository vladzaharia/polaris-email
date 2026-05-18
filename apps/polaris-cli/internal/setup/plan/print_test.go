package plan

import (
	"bytes"
	"strings"
	"testing"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/state"
)

func TestRender_EmptyPlan(t *testing.T) {
	t.Parallel()
	var buf bytes.Buffer
	Render(&buf, &Plan{})
	if !strings.Contains(buf.String(), "No changes") {
		t.Errorf("empty plan should say No changes, got: %q", buf.String())
	}
}

func TestRender_AllCreates(t *testing.T) {
	t.Parallel()
	plan := Diff(Desired(), &state.Doc{}, Snapshot{})
	var buf bytes.Buffer
	Render(&buf, plan)
	got := buf.String()
	if !strings.Contains(got, "to create") {
		t.Errorf("missing summary line, got: %q", got)
	}
	if !strings.Contains(got, "+ create") {
		t.Errorf("missing create prefix")
	}
	// R2 entry should carry its location hint in the suffix.
	if !strings.Contains(got, "location_hint=wnam") {
		t.Errorf("R2 suffix missing location_hint=wnam: %q", got)
	}
}

func TestRender_DriftEmitsHint(t *testing.T) {
	t.Parallel()
	plan := &Plan{
		Drift: []Entry{
			{Kind: KindKV, Name: "polaris-email-nonce", Action: ActionDrift, StateID: "kv-stale"},
		},
	}
	var buf bytes.Buffer
	Render(&buf, plan)
	got := buf.String()
	if !strings.Contains(got, "Drift detected") {
		t.Errorf("drift summary missing the friendly hint")
	}
	if !strings.Contains(got, "state-only id=kv-stale") {
		t.Errorf("drift entry missing state-only marker: %q", got)
	}
}

func TestRender_OnlySkips_QuietPath(t *testing.T) {
	t.Parallel()
	plan := &Plan{
		Skips: []Entry{
			{Kind: KindD1, Name: "polaris-email", Action: ActionSkip, LiveID: "db-1"},
		},
	}
	var buf bytes.Buffer
	Render(&buf, plan)
	got := buf.String()
	if !strings.Contains(got, "already present") {
		t.Errorf("all-skip path should call it out: %q", got)
	}
	if !strings.Contains(got, "id=db-1") {
		t.Errorf("skip should show the live id: %q", got)
	}
}

func TestRender_NilPlan(t *testing.T) {
	t.Parallel()
	var buf bytes.Buffer
	Render(&buf, nil)
	if buf.Len() == 0 {
		t.Error("nil plan should still produce some output")
	}
}
