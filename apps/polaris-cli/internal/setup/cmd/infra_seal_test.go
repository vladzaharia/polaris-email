package cmd

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/state"
)

// TestNewInfraGenesisSealCmd_Registered verifies the genesis-seal
// leaf is wired into `setup infra`.
func TestNewInfraGenesisSealCmd_Registered(t *testing.T) {
	root := NewSetupCmd(Options{CLIVersion: "v0.0.0-test"})
	infra := findSubcommand(root, "infra")
	if infra == nil {
		t.Fatal("setup infra subtree missing")
	}
	seal := findSubcommand(infra, "genesis-seal")
	if seal == nil {
		t.Fatal("setup infra genesis-seal leaf missing")
	}
	// Spot-check the required flags.
	for _, name := range []string{"secret", "webauthn-token", "no-browser", "force"} {
		if seal.Flags().Lookup(name) == nil {
			t.Errorf("genesis-seal missing --%s flag", name)
		}
	}
}

// TestGenesisSealCmd_HeadlessPath exercises the leaf end-to-end via a
// fake HTTP server.
func TestGenesisSealCmd_HeadlessPath(t *testing.T) {
	srv := newFakeBootstrapServer(t)
	statePath := filepath.Join(t.TempDir(), ".deploy-state.json")
	outPath := filepath.Join(t.TempDir(), ".bootstrap-output.json")

	root := newInfraGenesisSealCmd()
	args := []string{
		"--api-base-url=" + srv.url,
		"--secret=test-master-secret",
		"--webauthn-token=fake-jwt",
		"--state-path=" + statePath,
		"--output=" + outPath,
		"--no-browser",
		"--non-interactive",
	}
	out := &strings.Builder{}
	root.SetArgs(args)
	root.SetOut(out)
	root.SetErr(out)
	root.SetContext(context.Background())
	if err := root.Execute(); err != nil {
		t.Fatalf("execute: %v\nout=%s", err, out.String())
	}

	// State file should record the seal as complete.
	doc, err := state.Open(statePath).Read()
	if err != nil {
		t.Fatalf("read state: %v", err)
	}
	ph, ok := doc.Phases["genesis-seal"]
	if !ok {
		t.Fatal("phase genesis-seal not recorded")
	}
	if ph.CompletedAt.IsZero() {
		t.Error("genesis-seal completedAt is zero")
	}

	// Bootstrap output exists on disk mode 0600.
	stat, err := os.Stat(outPath)
	if err != nil {
		t.Fatalf("stat output: %v", err)
	}
	if stat.Mode().Perm() != 0o600 {
		t.Errorf("expected mode 0600, got %s", stat.Mode())
	}
}

// TestGenesisSealCmd_Resume verifies --force vs --resume behaviour on a
// state file that says the phase already completed.
func TestGenesisSealCmd_AlreadyComplete_NoForce(t *testing.T) {
	srv := newFakeBootstrapServer(t)
	statePath := filepath.Join(t.TempDir(), ".deploy-state.json")
	// Pre-seed state with a completed phase.
	pre := state.Open(statePath)
	doc, _ := pre.Read()
	doc.Phases = map[string]state.Phase{"genesis-seal": {CompletedAt: time.Now().UTC()}}
	if err := pre.Write(doc); err != nil {
		t.Fatalf("seed state: %v", err)
	}

	root := newInfraGenesisSealCmd()
	args := []string{
		"--api-base-url=" + srv.url,
		"--secret=test-master-secret",
		"--state-path=" + statePath,
		"--no-browser",
		"--non-interactive",
	}
	out := &strings.Builder{}
	root.SetArgs(args)
	root.SetOut(out)
	root.SetErr(out)
	root.SetContext(context.Background())
	if err := root.Execute(); err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !strings.Contains(out.String(), "already completed") {
		t.Errorf("expected short-circuit message, got: %s", out.String())
	}
	if srv.bootstrapCalls != 0 {
		t.Errorf("expected 0 bootstrap calls when phase already complete, got %d", srv.bootstrapCalls)
	}
}

// TestGenesisSealCmd_AlreadyBootstrapped covers the typed error path.
func TestGenesisSealCmd_AlreadyBootstrapped_RecordsPhase(t *testing.T) {
	srv := newFakeBootstrapServer(t)
	srv.bootstrapStatus = http.StatusConflict
	srv.bootstrapBody = `{"error":{"code":"already_bootstrapped","message":"x","retryable":false,"request_id":"r"}}`
	statePath := filepath.Join(t.TempDir(), ".deploy-state.json")

	root := newInfraGenesisSealCmd()
	args := []string{
		"--api-base-url=" + srv.url,
		"--secret=test-master-secret",
		"--state-path=" + statePath,
		"--no-browser",
		"--non-interactive",
	}
	out := &strings.Builder{}
	root.SetArgs(args)
	root.SetOut(out)
	root.SetErr(out)
	root.SetContext(context.Background())
	if err := root.Execute(); err != nil {
		t.Fatalf("execute: %v\nout=%s", err, out.String())
	}
	if !strings.Contains(out.String(), "already bootstrapped") {
		t.Errorf("expected friendly message, got: %s", out.String())
	}
	doc, _ := state.Open(statePath).Read()
	if doc.Phases["genesis-seal"].CompletedAt.IsZero() {
		t.Error("phase should be stamped complete even on already-bootstrapped")
	}
}

// --- fake server -----------------------------------------------------

type fakeBootstrapServer struct {
	url             string
	mu              sync.Mutex
	bootstrapCalls  int
	bootstrapStatus int
	bootstrapBody   string
}

func newFakeBootstrapServer(t *testing.T) *fakeBootstrapServer {
	t.Helper()
	f := &fakeBootstrapServer{}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/admin/bootstrap", func(w http.ResponseWriter, _ *http.Request) {
		f.mu.Lock()
		f.bootstrapCalls++
		f.mu.Unlock()
		if f.bootstrapStatus != 0 && f.bootstrapStatus != http.StatusOK {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(f.bootstrapStatus)
			_, _ = w.Write([]byte(f.bootstrapBody))
			return
		}
		body := map[string]string{
			"admin_key_id":       "01TESTKEY00000000000000000",
			"admin_key_secret":   "test-secret-abcdef",
			"mailbox_id":         "01MAILBOX00000000000000000",
			"setup_code":         "TESTCODE12345678",
			"webauthn_enrol_url": "http://example/setup/webauthn?code=TESTCODE12345678",
		}
		resp, _ := json.Marshal(body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(resp)
	})
	mux.HandleFunc("/v1/admin/setup/webauthn/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/complete") {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"status":"complete"}`))
			return
		}
		_, _ = w.Write([]byte(`{"status":"complete"}`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	f.url = srv.URL
	return f
}

