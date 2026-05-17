package rollback

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/state"
)

// fakeWranglerOnPath puts a stub wrangler binary at the head of PATH
// so wrangler.Run can find it. The stub exits 0 and echoes its args.
func fakeWranglerOnPath(t *testing.T) {
	t.Helper()
	_, this, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller")
	}
	// internal/setup/rollback → internal/setup/wrangler/testdata
	root := filepath.Dir(filepath.Dir(this))
	src := filepath.Join(root, "wrangler", "testdata", "fake-wrangler.sh")
	if _, err := os.Stat(src); err != nil {
		t.Skipf("missing fake wrangler at %s", src)
	}
	dir := t.TempDir()
	dst := filepath.Join(dir, "wrangler")
	in, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dst, in, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func TestRollbackDeploy_UsesPreviousVersionID(t *testing.T) {
	fakeWranglerOnPath(t)

	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "services", "api"), 0o755); err != nil {
		t.Fatal(err)
	}
	s := state.Open(filepath.Join(dir, ".deploy-state.json"))
	doc, _ := s.Read()
	doc.Deploys = map[string]state.DeployRecord{
		"api": {
			VersionID:         "current-vid",
			PreviousVersionID: "prev-vid",
			At:                time.Now().UTC(),
		},
	}
	if err := s.Write(doc); err != nil {
		t.Fatal(err)
	}

	var got struct {
		svc, vid string
		err      error
	}
	err := RollbackDeploy(context.Background(), "api", s, DeployOptions{
		RepoRoot: dir,
		Reporter: func(svc, vid string, err error) {
			got.svc, got.vid, got.err = svc, vid, err
		},
	})
	if err != nil {
		t.Fatalf("RollbackDeploy: %v", err)
	}
	if got.svc != "api" || got.vid != "prev-vid" {
		t.Errorf("reporter args: %+v", got)
	}

	after, _ := s.Read()
	rec := after.Deploys["api"]
	if rec.VersionID != "prev-vid" {
		t.Errorf("VersionID after rollback: got %q, want prev-vid", rec.VersionID)
	}
	if rec.PreviousVersionID != "current-vid" {
		t.Errorf("PreviousVersionID after rollback: got %q, want current-vid (the one we rolled FROM)", rec.PreviousVersionID)
	}
}

func TestRollbackDeploy_ExplicitToVersion(t *testing.T) {
	fakeWranglerOnPath(t)

	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "services", "api"), 0o755); err != nil {
		t.Fatal(err)
	}
	s := state.Open(filepath.Join(dir, ".deploy-state.json"))
	doc, _ := s.Read()
	doc.Deploys = map[string]state.DeployRecord{
		"api": {VersionID: "current-vid", At: time.Now().UTC()},
	}
	if err := s.Write(doc); err != nil {
		t.Fatal(err)
	}

	err := RollbackDeploy(context.Background(), "api", s, DeployOptions{
		RepoRoot:  dir,
		ToVersion: "explicit-vid",
	})
	if err != nil {
		t.Fatalf("RollbackDeploy: %v", err)
	}
	after, _ := s.Read()
	if after.Deploys["api"].VersionID != "explicit-vid" {
		t.Errorf("explicit version not adopted")
	}
}

func TestRollbackDeploy_RefusesUnknownService(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	s := state.Open(filepath.Join(dir, ".deploy-state.json"))
	err := RollbackDeploy(context.Background(), "totally-not-a-service", s, DeployOptions{})
	if err == nil {
		t.Fatal("want error on unknown service")
	}
	if !strings.Contains(err.Error(), "unknown service") {
		t.Errorf("error: %v", err)
	}
}

func TestRollbackDeploy_NoTargetErrors(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	s := state.Open(filepath.Join(dir, ".deploy-state.json"))
	doc, _ := s.Read()
	doc.Deploys = map[string]state.DeployRecord{
		"api": {VersionID: "current-vid"},
	}
	if err := s.Write(doc); err != nil {
		t.Fatal(err)
	}
	err := RollbackDeploy(context.Background(), "api", s, DeployOptions{RepoRoot: dir})
	if err == nil {
		t.Fatal("want error when no target available")
	}
	if !strings.Contains(err.Error(), "no target version") {
		t.Errorf("error should mention missing target: %v", err)
	}
}
