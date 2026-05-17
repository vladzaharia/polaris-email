package rollback

import (
	"bytes"
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/state"
)

func TestRollbackPhase_FlipsCompletedMarker(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	s := state.Open(filepath.Join(dir, ".deploy-state.json"))
	doc, _ := s.Read()
	doc.Phases = map[string]state.Phase{
		"deploy": {CompletedAt: time.Now().UTC(), ByVersion: "test"},
	}
	if err := s.Write(doc); err != nil {
		t.Fatal(err)
	}

	var buf bytes.Buffer
	if err := RollbackPhase(context.Background(), s, "deploy", PhaseOptions{Out: &buf}); err != nil {
		t.Fatalf("RollbackPhase: %v", err)
	}
	got, _ := s.Read()
	if _, present := got.Phases["deploy"]; present {
		t.Errorf("deploy phase should be removed/zeroed after rollback")
	}
	if !strings.Contains(buf.String(), "Manual remediation") {
		t.Error("output should print manual remediation steps")
	}
	if !strings.Contains(buf.String(), "rollback deploy") {
		t.Error("output should reference rollback deploy command")
	}
}

func TestRollbackPhase_RefusesUnknownPhase(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	s := state.Open(filepath.Join(dir, ".deploy-state.json"))
	err := RollbackPhase(context.Background(), s, "totally-not-a-phase", PhaseOptions{})
	if err == nil {
		t.Fatal("want error on unknown phase")
	}
	if !strings.Contains(err.Error(), "unknown phase") {
		t.Errorf("error should mention unknown phase: %v", err)
	}
}

func TestRollbackPhase_IdempotentOnAlreadyClean(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	s := state.Open(filepath.Join(dir, ".deploy-state.json"))
	var buf bytes.Buffer
	if err := RollbackPhase(context.Background(), s, "secrets", PhaseOptions{Out: &buf}); err != nil {
		t.Fatalf("idempotent path should not error: %v", err)
	}
	if !strings.Contains(buf.String(), "not marked complete") {
		t.Error("output should note the phase was not complete")
	}
}

func TestRollbackPhase_NeverDeletesResources(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	s := state.Open(filepath.Join(dir, ".deploy-state.json"))
	doc, _ := s.Read()
	doc.Phases = map[string]state.Phase{
		"provision": {CompletedAt: time.Now().UTC()},
	}
	doc.D1 = map[string]state.Resource{
		"polaris-email": {ID: "abc", Name: "polaris-email"},
	}
	doc.R2 = map[string]state.R2Bucket{
		"polaris-mail-archive": {Name: "polaris-mail-archive"},
	}
	if err := s.Write(doc); err != nil {
		t.Fatal(err)
	}

	if err := RollbackPhase(context.Background(), s, "provision", PhaseOptions{}); err != nil {
		t.Fatal(err)
	}
	got, _ := s.Read()
	if len(got.D1) != 1 || len(got.R2) != 1 {
		t.Errorf("rollback phase must preserve CF resources: D1=%d R2=%d", len(got.D1), len(got.R2))
	}
}

func TestRollbackPhase_KnownPhasesAllHaveRemediation(t *testing.T) {
	t.Parallel()
	if len(KnownPhases) == 0 {
		t.Fatal("KnownPhases should not be empty")
	}
	for _, p := range KnownPhases {
		if _, ok := PhaseRemediation[p]; !ok {
			t.Errorf("phase %q has no PhaseRemediation entry", p)
		}
	}
}
