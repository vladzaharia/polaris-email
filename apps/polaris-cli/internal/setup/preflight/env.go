package preflight

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/config"
)

// RequiredEnvKeys lists the .env.deploy keys preflight insists on.
// Mirrors the shell script's `for k in CF_ACCOUNT_ID POLARIS_API_HOSTNAME`
// loop. Synthetic-monitor + OIDC + B2 fields are NOT required — a stack
// without those subsystems is valid.
var RequiredEnvKeys = []string{
	"CF_ACCOUNT_ID",
	"POLARIS_API_HOSTNAME",
}

// CheckEnvDeploy asserts .env.deploy exists at envPath and contains
// every key in [RequiredEnvKeys].
//
// envPath is the absolute or repo-relative path to the .env.deploy
// file. Pass "" to default to ".env.deploy" in the current directory.
func CheckEnvDeploy(envPath string) Check {
	if envPath == "" {
		envPath = ".env.deploy"
	}
	return Check{
		Name:        ".env.deploy present + complete",
		Required:    true,
		Description: ".env.deploy must exist with CF_ACCOUNT_ID and POLARIS_API_HOSTNAME populated",
		Run: func(ctx context.Context) Result {
			_ = ctx
			if _, err := os.Stat(envPath); os.IsNotExist(err) {
				// The shell script downgrades this to warn ("run make
				// configure before make bootstrap"); we keep the same
				// semantics so the parity gate is clean.
				return warn(".env.deploy missing",
					"run `polaris-email setup infra configure` before `setup infra bootstrap`")
			} else if err != nil {
				return fail(fmt.Sprintf("stat .env.deploy: %v", err), "check filesystem permissions")
			}
			cfg, err := config.Load(envPath)
			if err != nil {
				return fail(fmt.Sprintf("parse .env.deploy: %v", err),
					"re-run `polaris-email setup infra configure` to rebuild the file")
			}
			env := cfg.AsMap()
			var missing []string
			for _, k := range RequiredEnvKeys {
				if strings.TrimSpace(env[k]) == "" {
					missing = append(missing, k)
				}
			}
			if len(missing) > 0 {
				return fail(
					fmt.Sprintf(".env.deploy missing required keys: %s", strings.Join(missing, ", ")),
					"run `polaris-email setup infra configure` to fill in the missing fields")
			}
			return pass(fmt.Sprintf("%s has required keys", envPath))
		},
	}
}
