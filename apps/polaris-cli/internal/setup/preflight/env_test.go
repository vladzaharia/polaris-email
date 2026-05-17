package preflight

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCheckEnvDeploy_Missing(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	c := CheckEnvDeploy(filepath.Join(dir, "no.env"))
	res := c.Run(context.Background())
	// Missing → warn (matches shell), not fail.
	if res.Status != StatusWarn {
		t.Errorf("missing .env.deploy should warn, got %+v", res)
	}
}

func TestCheckEnvDeploy_Complete(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	path := filepath.Join(dir, ".env.deploy")
	body := `CF_ACCOUNT_ID="abc"
POLARIS_API_HOSTNAME="api.example.com"
`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	res := CheckEnvDeploy(path).Run(context.Background())
	if res.Status != StatusPass {
		t.Errorf("complete file should pass, got %+v", res)
	}
}

func TestCheckEnvDeploy_MissingRequired(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	path := filepath.Join(dir, ".env.deploy")
	body := `CF_ACCOUNT_ID=""
POLARIS_API_HOSTNAME=""
`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	res := CheckEnvDeploy(path).Run(context.Background())
	if res.Status != StatusFail {
		t.Errorf("blank required keys should fail, got %+v", res)
	}
	if !strings.Contains(res.Detail, "CF_ACCOUNT_ID") {
		t.Errorf("Detail should name the missing key, got %q", res.Detail)
	}
}
