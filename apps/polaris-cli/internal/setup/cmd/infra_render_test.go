package cmd

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/state"
)

// TestRender_DryRun_SingleService verifies the bare-minimum happy path:
// `setup infra render --dry-run --service in` prints the rendered
// `services/in/wrangler.local.jsonc` to stdout, with the four
// references substituted.
func TestRender_DryRun_SingleService(t *testing.T) {
	dir := setupRenderFixture(t)

	cmd := newInfraRenderCmd()
	stdout, stderr := captureIO(cmd)
	cmd.SetArgs([]string{
		"--state-path", filepath.Join(dir, ".deploy-state.json"),
		"--env-path", filepath.Join(dir, ".env.deploy"),
		"--service", "in",
		"--dry-run",
	})
	chdir(t, dir)

	if err := cmd.Execute(); err != nil {
		t.Fatalf("Execute: %v\nstdout: %s\nstderr: %s", err, stdout, stderr)
	}
	out := stdout.String()
	for _, want := range []string{
		`"account_id": "cf-account-id"`,
		`"database_id": "d1-id"`,
		`"id": "kv-rate-limit-id"`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("dry-run output missing %q\n--- got ---\n%s", want, out)
		}
	}
	// No file should have been written.
	if _, err := os.Stat(filepath.Join(dir, "services/in/wrangler.local.jsonc")); !os.IsNotExist(err) {
		t.Errorf("dry-run should not create wrangler.local.jsonc, got err=%v", err)
	}
}

// TestRender_WritesAllServices walks every entry in renderableServices,
// renders, and verifies a wrangler.local.jsonc landed at the expected
// path with the expected mode + content.
func TestRender_WritesAllServices(t *testing.T) {
	dir := setupRenderFixture(t)

	cmd := newInfraRenderCmd()
	stdout, stderr := captureIO(cmd)
	cmd.SetArgs([]string{
		"--state-path", filepath.Join(dir, ".deploy-state.json"),
		"--env-path", filepath.Join(dir, ".env.deploy"),
	})
	chdir(t, dir)

	if err := cmd.Execute(); err != nil {
		t.Fatalf("Execute: %v\nstdout: %s\nstderr: %s", err, stdout, stderr)
	}

	for _, svc := range renderableServices {
		out := filepath.Join(dir, svc.Dir, "wrangler.local.jsonc")
		st, err := os.Stat(out)
		if err != nil {
			t.Errorf("%s: missing output: %v", svc.Name, err)
			continue
		}
		if st.Mode().Perm() != 0o644 {
			t.Errorf("%s: mode %o, want 0644", svc.Name, st.Mode().Perm())
		}
		b, err := os.ReadFile(out)
		if err != nil {
			t.Fatalf("%s: read: %v", svc.Name, err)
		}
		if !bytes.Contains(b, []byte(`"account_id": "cf-account-id"`)) {
			t.Errorf("%s: account_id not substituted:\n%s", svc.Name, b)
		}
	}
}

// TestRender_UnknownService surfaces typos as hard errors rather than
// silently rendering nothing.
func TestRender_UnknownService(t *testing.T) {
	dir := setupRenderFixture(t)
	cmd := newInfraRenderCmd()
	stdout, stderr := captureIO(cmd)
	cmd.SetArgs([]string{
		"--state-path", filepath.Join(dir, ".deploy-state.json"),
		"--env-path", filepath.Join(dir, ".env.deploy"),
		"--service", "nope",
	})
	chdir(t, dir)
	if err := cmd.Execute(); err == nil {
		t.Fatalf("Execute: want error on unknown service\nstdout: %s\nstderr: %s", stdout, stderr)
	}
}

// TestRender_MissingInputs_FailsLoudly — the whole point of the
// rewrite. Drop a required env value and confirm the renderer refuses to
// produce output (envsubst would have emitted "").
func TestRender_MissingInputs_FailsLoudly(t *testing.T) {
	dir := setupRenderFixture(t)
	// Clobber the env file with a deliberately-incomplete one.
	if err := os.WriteFile(filepath.Join(dir, ".env.deploy"), []byte(`CF_ACCOUNT_ID="x"
`), 0o600); err != nil {
		t.Fatalf("seed env: %v", err)
	}
	cmd := newInfraRenderCmd()
	captureIO(cmd)
	cmd.SetArgs([]string{
		"--state-path", filepath.Join(dir, ".deploy-state.json"),
		"--env-path", filepath.Join(dir, ".env.deploy"),
	})
	chdir(t, dir)
	err := cmd.Execute()
	if err == nil {
		t.Fatal("Execute: want validation error on missing inputs")
	}
	if !strings.Contains(err.Error(), "missing") {
		t.Errorf("error should mention missing inputs: %v", err)
	}
}

// TestRender_Merge_ReplacesShellPipeline — the --merge mode is the
// replacement for sed | jq -s '.[0] * .[1]'. Run it on a representative
// pair of inputs and verify comments survive + overlay wins.
func TestRender_Merge_ReplacesShellPipeline(t *testing.T) {
	dir := t.TempDir()
	base := filepath.Join(dir, "base.jsonc")
	overlay := filepath.Join(dir, "overlay.jsonc")
	out := filepath.Join(dir, "out.jsonc")
	if err := os.WriteFile(base, []byte(`// header
{
  // comment
  "name": "polaris-mail-api",
  "d1_databases": [
    { "binding": "DB", "database_id": "REPLACE_WITH_LOCAL" }
  ]
}`), 0o644); err != nil {
		t.Fatalf("seed base: %v", err)
	}
	if err := os.WriteFile(overlay, []byte(`{
  "account_id": "acc-123",
  "d1_databases": [
    { "binding": "DB", "database_id": "real-id" }
  ]
}`), 0o644); err != nil {
		t.Fatalf("seed overlay: %v", err)
	}

	cmd := newInfraRenderCmd()
	captureIO(cmd)
	cmd.SetArgs([]string{"--merge", base, "--overlay", overlay, "-o", out})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	b, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("read out: %v", err)
	}
	s := string(b)
	for _, want := range []string{
		"// header",
		"// comment",
		`"account_id": "acc-123"`,
		`"name": "polaris-mail-api"`,
		`"database_id": "real-id"`,
	} {
		if !strings.Contains(s, want) {
			t.Errorf("merge output missing %q\n--- got ---\n%s", want, s)
		}
	}
}

// TestRender_Merge_StdoutDefault — without -o, --merge writes to
// stdout so callers can capture the merged JSONC via shell
// redirection.
func TestRender_Merge_StdoutDefault(t *testing.T) {
	dir := t.TempDir()
	base := filepath.Join(dir, "base.jsonc")
	overlay := filepath.Join(dir, "overlay.jsonc")
	_ = os.WriteFile(base, []byte(`{ "a": 1 }`), 0o644)
	_ = os.WriteFile(overlay, []byte(`{ "b": 2 }`), 0o644)

	cmd := newInfraRenderCmd()
	stdout, _ := captureIO(cmd)
	cmd.SetArgs([]string{"--merge", base, "--overlay", overlay})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if !strings.Contains(stdout.String(), `"a": 1`) || !strings.Contains(stdout.String(), `"b": 2`) {
		t.Errorf("stdout missing merged fields: %s", stdout.String())
	}
}

// setupRenderFixture builds a self-contained fixture: a copy of the
// four service templates + a populated .deploy-state.json + .env.deploy
// under a temp dir, so the render command has a real on-disk world to
// operate on without touching the live repo.
func setupRenderFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()

	// Build a state file with every resource the templates reference.
	doc := &state.Doc{
		SchemaVersion: state.CurrentSchema,
		AccountID:     "cf-account-id",
		D1: map[string]state.Resource{
			"polaris-mail": {ID: "d1-id", Name: "polaris-mail"},
		},
		R2: map[string]state.R2Bucket{
			"polaris-mail": {Name: "polaris-mail", Jurisdiction: "eu"},
		},
		KV: map[string]state.Resource{
			"polaris-mail-nonce":       {ID: "kv-nonce-id", Name: "polaris-mail-nonce"},
			"polaris-mail-idempotency": {ID: "kv-idem-id", Name: "polaris-mail-idempotency"},
			"polaris-mail-rate-limit":  {ID: "kv-rate-limit-id", Name: "polaris-mail-rate-limit"},
			"polaris-mail-key-cache":   {ID: "kv-kc-id", Name: "polaris-mail-key-cache"},
			"polaris-mail-revocations": {ID: "kv-rev-id", Name: "polaris-mail-revocations"},
		},
	}
	s := state.Open(filepath.Join(dir, ".deploy-state.json"))
	if err := s.Write(doc); err != nil {
		t.Fatalf("write state: %v", err)
	}

	// Drop a known-good .env.deploy.
	if err := os.WriteFile(filepath.Join(dir, ".env.deploy"), []byte(`CF_ACCOUNT_ID="cf-account-id"
POLARIS_API_HOSTNAME="api.example.com"
POLARIS_PANEL_HOSTNAME="panel.example.com"
R2_PUBLIC_HOST="r2.example.com"
ALERT_WEBHOOK="https://alerts.example.com/hook"
SYNTHETIC_FROM="synthetic@example.com"
SYNTHETIC_TO="synthetic@in.example.com"
SYNTHETIC_MONITOR_DOMAIN="example.com"
OIDC_ISSUER="https://oidc.example.com"
OIDC_CLIENT_ID="client-abc"
`), 0o600); err != nil {
		t.Fatalf("write env: %v", err)
	}

	// Copy each renderable template into the fixture so the command
	// has something to render.
	repoRoot := findRepoRoot(t)
	for _, svc := range renderableServices {
		src := filepath.Join(repoRoot, svc.Dir, "wrangler.local.template.jsonc")
		dst := filepath.Join(dir, svc.Dir, "wrangler.local.template.jsonc")
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", dst, err)
		}
		b, err := os.ReadFile(src)
		if err != nil {
			t.Fatalf("read live template %s: %v", src, err)
		}
		if err := os.WriteFile(dst, b, 0o644); err != nil {
			t.Fatalf("write fixture template %s: %v", dst, err)
		}
	}
	return dir
}

// findRepoRoot walks up from the test's package directory looking for
// pnpm-workspace.yaml. Shared verbatim with the wranglercfg golden
// test; if it gets a third caller it should move to a test-helper
// package.
func findRepoRoot(t *testing.T) string {
	t.Helper()
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd: %v", err)
	}
	for dir := cwd; ; {
		if _, err := os.Stat(filepath.Join(dir, "pnpm-workspace.yaml")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("repo root not found from %s", cwd)
		}
		dir = parent
	}
}

// chdir is a t.Chdir polyfill — t.Chdir landed in Go 1.24 and the
// polaris-cli module pins to 1.23 so the broader monorepo can build
// on older toolchains.
func chdir(t *testing.T, dir string) {
	t.Helper()
	prev, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd: %v", err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatalf("Chdir %s: %v", dir, err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(prev); err != nil {
			t.Errorf("restore cwd: %v", err)
		}
	})
}

// captureIO swaps the cobra command's stdout/stderr for byte buffers
// the test can later assert against. Returns both so the caller can
// log them in failure messages. We declare the parameter as the cobra
// concrete type rather than an interface to keep the helper trivially
// callable from every test in this package.
func captureIO(cmd *cobra.Command) (*bytes.Buffer, *bytes.Buffer) {
	var stdout, stderr bytes.Buffer
	cmd.SetOut(&stdout)
	cmd.SetErr(&stderr)
	return &stdout, &stderr
}
