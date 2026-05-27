//go:build mailtest_contract

// Package mailtest_contract provides the Harness that exercises the
// bridge against a REAL services/api Worker running on wrangler dev
// (with miniflare-emulated D1/KV/R2). It validates that the Go SDK +
// the TypeScript Worker stay in wire-protocol sync.
//
// Per the plan, this suite uses ONLY production-shipping admin
// endpoints (no test-mode routes are added to services/api). State
// isolation is achieved by registering a fresh bridge per test with
// a uuid-suffixed name.
//
// Run locally:
//
//	go test -tags=mailtest_contract -race -timeout 22m \
//	    ./apps/mail-bridge/test/mailtest_contract/...
//
// Prerequisites:
//   - pnpm + wrangler + node 22+ on PATH
//   - `pnpm --filter @polaris-mail/api install` succeeds
//   - wrangler can run services/api locally with `wrangler dev --local`
//
// Current scope: this iteration brings up wrangler dev and verifies
// /healthz responds; the full HMAC-roundtrip + bridge-registration
// flow requires bootstrapping an admin operator via genesis-seal
// (polaris-mail setup infra genesis-seal), which lives in a follow-up
// PR. Individual scenario tests beyond the smoke check call t.Skip
// with that pointer until the bootstrap orchestration lands.
package mailtest_contract

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	mt "github.com/vladzaharia/polaris-email/apps/mail-bridge/test/mailtest"
)

// WranglerBaseURL is set by TestMain after wrangler dev reports ready.
// Per-test factories read it to build the contractHarness.
var WranglerBaseURL string

// StartWrangler boots wrangler dev with services/api's test config.
// Returns the base URL once /healthz responds 200, and a cleanup func
// to terminate the process.
//
// Before starting the dev server, the function applies the migrations
// listed in `migrations_dir` against the local D1 simulator — wrangler
// dev itself doesn't auto-apply, so without this step the bootstrap
// endpoint hits "no such table: api_keys".
func StartWrangler(ctx context.Context, port int, repoRoot string) (string, func(), error) {
	// Migrate first.
	migrate := exec.CommandContext(ctx, "npx", "wrangler", "d1", "migrations", "apply",
		"polaris-mail", "--local", "--config", "wrangler.test.jsonc")
	migrate.Dir = filepath.Join(repoRoot, "services", "api")
	migrate.Stdout = os.Stderr
	migrate.Stderr = os.Stderr
	if err := migrate.Run(); err != nil {
		return "", nil, fmt.Errorf("d1 migrate: %w", err)
	}

	args := []string{
		"wrangler", "dev",
		"--config", "wrangler.test.jsonc",
		"--port", strconv.Itoa(port),
		"--inspector-port", "0",
		"--local",
	}
	cmd := exec.CommandContext(ctx, "npx", args...)
	cmd.Dir = filepath.Join(repoRoot, "services", "api")
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		return "", nil, fmt.Errorf("wrangler dev: %w", err)
	}
	cleanup := func() {
		if cmd.Process != nil {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
			_, _ = cmd.Process.Wait()
		}
	}
	baseURL := fmt.Sprintf("http://127.0.0.1:%d", port)
	deadline := time.Now().Add(60 * time.Second)
	client := &http.Client{Timeout: 2 * time.Second}
	for time.Now().Before(deadline) {
		resp, err := client.Get(baseURL + "/healthz")
		if err == nil && resp.StatusCode == 200 {
			_ = resp.Body.Close()
			return baseURL, cleanup, nil
		}
		if resp != nil {
			_ = resp.Body.Close()
		}
		time.Sleep(500 * time.Millisecond)
	}
	cleanup()
	return "", nil, errors.New("wrangler dev /healthz never returned 200")
}

// NewFactory returns a HarnessFactory that drives a real services/api
// Worker via wrangler dev.
//
// Most scenarios currently t.Skip because they require admin
// authentication, which depends on the genesis-seal bootstrap flow
// (operator + api_key seeding into D1 + KV). The smoke contract test
// in mailtest_contract_test.go runs against the live wrangler instance
// to validate the harness orchestration.
func NewFactory(_ *mt.CA) mt.HarnessFactory {
	return func(t *testing.T, opts mt.HarnessOpts) mt.Harness {
		t.Skip("mailtest_contract: scenario-level Harness requires bootstrap (genesis-seal); only the smoke test runs today")
		return nil
	}
}

// contractHarness is a stubbed Harness for forward-compatibility. Real
// scenarios go through NewFactory's t.Skip path; this struct exists so
// the type satisfies mt.Harness for static checks.
type contractHarness struct {
	t       *testing.T
	baseURL string

	mu        sync.Mutex
	cmd       *exec.Cmd
	stopped   atomic.Bool
	cmdExited chan struct{}
}

func (h *contractHarness) Start(_ context.Context) error          { return errors.New("not impl") }
func (h *contractHarness) Stop(_ context.Context) error           { return nil }
func (h *contractHarness) Bridge() mt.Bridge                      { return mt.Bridge{} }
func (h *contractHarness) SMTPSAddr() string                      { return "" }
func (h *contractHarness) SMTPAddr() string                       { return "" }
func (h *contractHarness) IMAPSAddr() string                      { return "" }
func (h *contractHarness) IMAPAddr() string                       { return "" }
func (h *contractHarness) WebhookAddr() string                    { return "" }
func (h *contractHarness) APIBaseURL() string                     { return h.baseURL }
func (h *contractHarness) CABundle() *tls.Config                  { return nil }
func (h *contractHarness) ReplaceCert(_ *testing.T, _ tls.Certificate) {}
func (h *contractHarness) Fake() mt.FakeControlPlane              { return nil }
func (h *contractHarness) BridgeLogs() io.Reader                  { return strings.NewReader("") }
func (h *contractHarness) SendSignal(_ os.Signal) error           { return nil }
func (h *contractHarness) RestartBridge(_ context.Context) error  { return nil }
func (h *contractHarness) WaitForRestart(_ context.Context) error { return nil }
func (h *contractHarness) ReadHMACKeyFile() []byte                { return nil }
