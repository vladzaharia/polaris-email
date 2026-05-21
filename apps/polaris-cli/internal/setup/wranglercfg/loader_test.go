package wranglercfg

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/state"
)

// TestLoadInputs_FromStateAndEnv covers the happy path: a state.Doc
// populated with all five KV namespaces + a D1 DB + R2 bucket, plus a
// .env.deploy with the matching env keys, should produce inputs that
// pass Validate().
func TestLoadInputs_FromStateAndEnv(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	envFile := filepath.Join(dir, ".env.deploy")
	if err := os.WriteFile(envFile, []byte(`# generated .env.deploy fixture
CF_ACCOUNT_ID="cf-account-id"
POLARIS_API_HOSTNAME="api.example.com"
POLARIS_PANEL_HOSTNAME="panel.example.com"
R2_PUBLIC_HOST="r2.example.com"
SYNTHETIC_FROM="synthetic@example.com"
SYNTHETIC_TO="synthetic@in.example.com"
SYNTHETIC_MONITOR_DOMAIN="example.com"
ALERT_WEBHOOK="https://alerts.example.com/hook"
OIDC_ISSUER="https://oidc.example.com"
OIDC_CLIENT_ID="client-abc"
`), 0o600); err != nil {
		t.Fatalf("seed env: %v", err)
	}

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
			"polaris-mail-nonce":       {ID: "kv-nonce", Name: "polaris-mail-nonce"},
			"polaris-mail-idempotency": {ID: "kv-idem", Name: "polaris-mail-idempotency"},
			"polaris-mail-rate-limit":  {ID: "kv-rl", Name: "polaris-mail-rate-limit"},
			"polaris-mail-key-cache":   {ID: "kv-kc", Name: "polaris-mail-key-cache"},
			"polaris-mail-revocations": {ID: "kv-rev", Name: "polaris-mail-revocations"},
		},
	}

	in, err := LoadInputs(doc, envFile)
	if err != nil {
		t.Fatalf("LoadInputs: %v", err)
	}
	if err := in.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}

	// Spot-check a few fields end-to-end.
	if in.Account.ID != "cf-account-id" {
		t.Errorf("Account.ID: %q", in.Account.ID)
	}
	if in.D1.PolarisMail.ID != "d1-id" {
		t.Errorf("D1: %+v", in.D1)
	}
	if in.KV.Revocations.ID != "kv-rev" {
		t.Errorf("KV.Revocations: %+v", in.KV.Revocations)
	}
	if in.Hostnames.R2Public != "r2.example.com" {
		t.Errorf("R2Public: %q", in.Hostnames.R2Public)
	}
	if in.OIDC.Issuer != "https://oidc.example.com" {
		t.Errorf("OIDC.Issuer: %q", in.OIDC.Issuer)
	}
	if in.AlertWebhook != "https://alerts.example.com/hook" {
		t.Errorf("AlertWebhook: %q", in.AlertWebhook)
	}
	if in.R2.PolarisMail.Jurisdiction != "eu" {
		t.Errorf("R2 jurisdiction: %+v", in.R2.PolarisMail)
	}
}

// TestLoadInputs_EnvFileAbsent — when .env.deploy isn't there, we fall
// back to the process environment. This is how the CLI works in CI.
func TestLoadInputs_EnvFileAbsent(t *testing.T) {
	dir := t.TempDir()
	missing := filepath.Join(dir, "nope.env")

	t.Setenv("CF_ACCOUNT_ID", "from-env")
	t.Setenv("POLARIS_API_HOSTNAME", "api.fromenv.example")

	in, err := LoadInputs(&state.Doc{}, missing)
	if err != nil {
		t.Fatalf("LoadInputs: %v", err)
	}
	if in.Account.ID != "from-env" {
		t.Errorf("Account.ID from process env: %q", in.Account.ID)
	}
	if in.Hostnames.PolarisAPI != "api.fromenv.example" {
		t.Errorf("PolarisAPI from process env: %q", in.Hostnames.PolarisAPI)
	}
}

// TestLoadInputs_EnvFileWinsOverProcessEnv — when both are set, the
// file's value wins. This matches `set -a; source .env.deploy` semantics
// (the file overrides anything in the parent shell).
func TestLoadInputs_EnvFileWinsOverProcessEnv(t *testing.T) {
	dir := t.TempDir()
	envFile := filepath.Join(dir, ".env.deploy")
	if err := os.WriteFile(envFile, []byte(`CF_ACCOUNT_ID="from-file"`), 0o600); err != nil {
		t.Fatalf("seed env: %v", err)
	}
	t.Setenv("CF_ACCOUNT_ID", "from-process")

	in, err := LoadInputs(&state.Doc{}, envFile)
	if err != nil {
		t.Fatalf("LoadInputs: %v", err)
	}
	if in.Account.ID != "from-file" {
		t.Errorf("file should win: got %q", in.Account.ID)
	}
}

// TestLoadInputs_QuoteStripping — configure.sh writes KEY="value"; we
// should strip the quotes (just like `source .env.deploy` would).
func TestLoadInputs_QuoteStripping(t *testing.T) {
	dir := t.TempDir()
	envFile := filepath.Join(dir, ".env.deploy")
	body := `DOUBLE_QUOTED="hello"
SINGLE_QUOTED='world'
UNQUOTED=naked
EMPTY=""
`
	if err := os.WriteFile(envFile, []byte(body), 0o600); err != nil {
		t.Fatalf("seed env: %v", err)
	}
	// Read internally via a roundabout: use LoadInputs with state where
	// AccountID = $CF_ACCOUNT_ID isn't set; we re-read with a known key.
	t.Setenv("DOUBLE_QUOTED", "")
	t.Setenv("SINGLE_QUOTED", "")
	t.Setenv("UNQUOTED", "")
	t.Setenv("EMPTY", "")

	parsed, err := loadEnvFile(envFile)
	if err != nil {
		t.Fatalf("loadEnvFile: %v", err)
	}
	if parsed["DOUBLE_QUOTED"] != "hello" {
		t.Errorf("DOUBLE_QUOTED: %q", parsed["DOUBLE_QUOTED"])
	}
	if parsed["SINGLE_QUOTED"] != "world" {
		t.Errorf("SINGLE_QUOTED: %q", parsed["SINGLE_QUOTED"])
	}
	if parsed["UNQUOTED"] != "naked" {
		t.Errorf("UNQUOTED: %q", parsed["UNQUOTED"])
	}
	if parsed["EMPTY"] != "" {
		t.Errorf("EMPTY: %q", parsed["EMPTY"])
	}
}

func TestLoadInputs_MalformedEnvLine(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	envFile := filepath.Join(dir, ".env.deploy")
	if err := os.WriteFile(envFile, []byte("ok=1\nnotanenvline\nb=2\n"), 0o600); err != nil {
		t.Fatalf("seed env: %v", err)
	}
	_, err := LoadInputs(&state.Doc{}, envFile)
	if err == nil {
		t.Fatal("LoadInputs: want error on malformed env line")
	}
}

// TestLoadInputs_PartialState — missing state entries are left zero so
// Validate can produce a specific error. We do NOT pre-fill with
// fallbacks (which would mask real misconfiguration).
func TestLoadInputs_PartialState(t *testing.T) {
	t.Parallel()
	doc := &state.Doc{
		SchemaVersion: state.CurrentSchema,
		D1: map[string]state.Resource{
			"polaris-mail": {ID: "d1-id"},
		},
		// KV deliberately absent.
	}
	in, err := LoadInputs(doc, "")
	if err != nil {
		t.Fatalf("LoadInputs: %v", err)
	}
	if in.D1.PolarisMail.ID != "d1-id" {
		t.Errorf("D1: %+v", in.D1)
	}
	if in.KV.Nonce.ID != "" {
		t.Errorf("KV.Nonce should be empty (state absent), got %+v", in.KV.Nonce)
	}
	// Validate should now complain — pointer-distinct from a happy
	// LoadInputs that just happens to be missing one thing.
	if err := in.Validate(); err == nil {
		t.Fatal("Validate: want error on partial state")
	}
}
