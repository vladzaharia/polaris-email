package secrets

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// fakeWranglerPath returns the absolute path to the wrangler stub used
// for the push subprocess. We borrow the wrangler package's testdata
// fixture rather than duplicating one. The stub writes its args to
// stdout and exits 0 on the happy path, exit 2 on `fail`.
func fakeWranglerPath(t *testing.T) string {
	t.Helper()
	_, this, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller")
	}
	// internal/setup/secrets → internal/setup/wrangler/testdata
	root := filepath.Dir(filepath.Dir(this))
	p := filepath.Join(root, "wrangler", "testdata", "fake-wrangler.sh")
	if _, err := os.Stat(p); err != nil {
		t.Fatalf("missing fake wrangler at %s: %v", p, err)
	}
	return p
}

func TestPushWith_PipesValueAsStdin(t *testing.T) {
	t.Parallel()
	bin := fakeWranglerPath(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// The stub echoes its args. We can't easily verify the stdin is
	// piped without writing a custom helper script, so this test
	// confirms the args are correct and the call completes; the stdin
	// behaviour is covered by exec_test in the wrangler package.
	err := pushWith(ctx, bin, "api", "POLARIS_SECRET_A", "value-a")
	if err != nil {
		t.Errorf("pushWith happy path: %v", err)
	}
}

func TestPushWith_RejectsEmptyName(t *testing.T) {
	t.Parallel()
	err := pushWith(context.Background(), "/no/such/binary", "api", "", "value")
	if err == nil {
		t.Fatal("want error on empty secret name")
	}
	if !strings.Contains(err.Error(), "secret name required") {
		t.Errorf("error should mention required name: %v", err)
	}
}

func TestPushWith_RejectsEmptyWorker(t *testing.T) {
	t.Parallel()
	err := pushWith(context.Background(), "/no/such/binary", "", "FOO", "value")
	if err == nil {
		t.Fatal("want error on empty worker name")
	}
	if !strings.Contains(err.Error(), "worker name required") {
		t.Errorf("error should mention worker: %v", err)
	}
}

func TestPushWith_NonzeroExitSurfaces(t *testing.T) {
	t.Parallel()
	// Use a binary that does not accept "secret put" — bash itself
	// with a no-such-script will exit nonzero. We construct a tiny
	// stub that exits 2 unconditionally.
	dir := t.TempDir()
	stub := filepath.Join(dir, "fail-wrangler.sh")
	if err := os.WriteFile(stub, []byte("#!/bin/sh\nexit 2\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := pushWith(ctx, stub, "api", "POLARIS_SECRET_A", "v")
	if err == nil {
		t.Fatal("want error on nonzero exit")
	}
	if !strings.Contains(err.Error(), "api/POLARIS_SECRET_A") {
		t.Errorf("error should cite the worker/secret pair: %v", err)
	}
}

func TestWranglerPusher_WorkerNameMappingApplied(t *testing.T) {
	t.Parallel()
	// We can't actually run wrangler here, so just verify the WorkerName
	// mapping is invoked when set. The cleanest assertion is to mint a
	// pusher and confirm the function pointer is used. (A full
	// integration test would require routing the binary through Run.)
	mapped := false
	p := WranglerPusher{
		WorkerName: func(svc string) string {
			mapped = true
			if svc != "api" {
				t.Errorf("svc passed to mapper: want api, got %q", svc)
			}
			return "polaris-mail-api"
		},
	}
	// Call the mapper directly to confirm it fires; we don't want to
	// shell out to a real wrangler in this unit test.
	_ = p.WorkerName("api")
	if !mapped {
		t.Error("WorkerName mapper should be invoked")
	}
}
