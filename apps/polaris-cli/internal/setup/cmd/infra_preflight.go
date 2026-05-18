package cmd

import (
	"context"
	"fmt"

	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/output"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/config"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/preflight"
)

// newInfraPreflightCmd wires `polaris-email setup infra preflight` — the
// Go port of bin/preflight.sh. Both implementations must agree on
// pass/fail counts; `make parity` diffs them in CI.
//
// Flags:
//
//	--env-file <path>     override .env.deploy location (default ./.env.deploy)
//	--required-only       skip non-required checks (mirrors POLARIS_REQUIRE_DOCKER=0)
//	-o, --output table|json   render mode (json is for CI integration)
//	--no-cf-probe         skip the Cloudflare API token scope probe
//	                      (useful in CI where the token isn't available)
//	--repo-root <path>    repo root for the git-tracking check (defaults to cwd)
func newInfraPreflightCmd() *cobra.Command {
	var (
		envFile      string
		repoRoot     string
		outputFmt    string
		requiredOnly bool
		noCFProbe    bool
	)
	c := &cobra.Command{
		Use:   "preflight",
		Short: "Verify tooling, .env.deploy, and CF token scopes before bootstrap",
		Long: "Verify the local environment is ready for `setup infra bootstrap`.\n" +
			"\n" +
			"This command is the Go port of bin/preflight.sh. Both flows are\n" +
			"diffed by `make parity` in CI — any divergence breaks the build.\n" +
			"\n" +
			"Exit code is non-zero on any FAIL (warns alone exit 0).",
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			if ctx == nil {
				ctx = context.Background()
			}

			// Best-effort load of .env.deploy so the CF check has inputs
			// to probe with. Missing file is fine — the env-deploy check
			// itself will report it.
			cfg, _ := config.LoadOrDefault(envFile)

			checks := assembleChecks(cfg, envFile, repoRoot, noCFProbe)
			results, sum := preflight.Run(ctx, checks, requiredOnly)

			f, err := output.ParseFormat(outputFmt)
			if err != nil {
				return err
			}
			w := cmd.OutOrStdout()
			switch f {
			case output.FormatJSON:
				payload := struct {
					Summary preflight.Summary       `json:"summary"`
					Results []preflight.CheckResult `json:"results"`
				}{sum, results}
				if err := output.EmitJSON(w, payload); err != nil {
					return err
				}
			case output.FormatYAML:
				payload := struct {
					Summary preflight.Summary       `json:"summary"`
					Results []preflight.CheckResult `json:"results"`
				}{sum, results}
				if err := output.EmitYAML(w, payload); err != nil {
					return err
				}
			default:
				fmt.Fprintln(w, "polaris-email preflight")
				fmt.Fprintln(w)
				preflight.RenderText(w, results, sum)
			}

			if sum.HasFail() {
				// Return a typed error so cobra exits non-zero without
				// re-printing the friendly text we just emitted.
				return errPreflightFailed
			}
			return nil
		},
	}
	c.Flags().StringVar(&envFile, "env-file", defaultEnvFile, "path to .env.deploy")
	c.Flags().StringVar(&repoRoot, "repo-root", "", "override the repo root used by the git-tracking check (default: cwd)")
	c.Flags().StringVarP(&outputFmt, "output", "o", "table", "output format: table|json|yaml")
	c.Flags().BoolVar(&requiredOnly, "required-only", false, "skip non-required checks (no scopes, no docker)")
	c.Flags().BoolVar(&noCFProbe, "no-cf-probe", false, "skip the Cloudflare API scope probe even when CF_API_TOKEN is set")
	return c
}

// assembleChecks builds the standard preflight list. The order matters
// for output stability — operators eyeball the table.
func assembleChecks(cfg *config.Config, envFile, repoRoot string, noCFProbe bool) []preflight.Check {
	checks := []preflight.Check{
		preflight.CheckPnpm(),
		preflight.CheckWranglerInstalled(),
		preflight.CheckWranglerLoggedIn(),
		preflight.CheckJq(),
		preflight.CheckOpenSSL(),
		preflight.CheckGit(),
		preflight.CheckCurl(),
		preflight.CheckEnvsubst(),
		preflight.CheckPolarisEmail(),
		preflight.CheckGitTrackedServices(repoRoot),
		preflight.CheckEnvDeploy(envFile),
	}
	if !noCFProbe {
		checks = append(checks, preflight.CheckCFAPIToken(preflight.CFAPIConfig{
			Token:     cfg.CFAPIToken,
			AccountID: cfg.CFAccountID,
		}))
	}
	return checks
}

// errPreflightFailed is a sentinel error so cobra exits non-zero
// without re-rendering text we already emitted. RootCmd's
// SilenceErrors=true keeps the user from seeing this twice.
var errPreflightFailed = errCli("preflight failed")

// errCli is a minimal error type used for clean CLI exits.
type errCli string

func (e errCli) Error() string { return string(e) }

// defaultEnvFile is the standard .env.deploy location. Surfaced as a
// constant so the configure leaf can reuse it.
const defaultEnvFile = ".env.deploy"
