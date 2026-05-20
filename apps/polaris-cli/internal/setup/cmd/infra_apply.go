package cmd

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/charmbracelet/huh"
	"github.com/mattn/go-isatty"
	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/cfapi"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/config"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/plan"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/provision"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/state"
)

// newInfraApplyCmd wires `polaris-email setup infra apply` — the
// write side of plan/apply. It walks plan.Diff().Creates in the same
// terraform-style flow, but actually invokes cfapi.Create* for each
// missing resource and records the result into .deploy-state.json
// atomically.
//
// Safety properties:
//
//   - Confirms with huh.NewConfirm unless --yes (or stdin isn't a TTY).
//   - --dry-run exits after the plan stage; no CF writes.
//   - Resumes cleanly on re-invocation: state is committed after every
//     successful create, so a kill -9 mid-run picks up on next apply.
func newInfraApplyCmd() *cobra.Command {
	var (
		envFile        string
		statePath      string
		token          string
		accountID      string
		dryRun         bool
		yes            bool
		nonInteractive bool
	)
	c := &cobra.Command{
		Use:   "apply",
		Short: "Create the Cloudflare resources polaris-email needs (idempotent)",
		Long: "Walk the create-plan and provision missing Cloudflare resources.\n" +
			"\n" +
			"State is written to .deploy-state.json atomically after every\n" +
			"successful resource create, so an aborted run (Ctrl-C, kill\n" +
			"-9, transient CF outage) resumes cleanly on the next apply.\n" +
			"\n" +
			"--dry-run still computes the plan + prints it, but stops short\n" +
			"of any HTTP write.",
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			if ctx == nil {
				ctx = context.Background()
			}

			cfg, _ := config.LoadOrDefault(envFile)
			tok, acct := resolveCFCreds(token, accountID, cfg)

			// Credentials are required for real applies. --dry-run is
			// allowed to proceed against state alone so operators can
			// preview off a fixture without CF reachability.
			if !dryRun && (tok == "" || acct == "") {
				return fmt.Errorf("missing Cloudflare credentials (need CF_API_TOKEN + CF_ACCOUNT_ID)")
			}

			store := state.Open(pickPath(statePath, defaultStatePath))
			doc, err := store.Read()
			if err != nil {
				return fmt.Errorf("read state: %w", err)
			}

			// Live snapshot: required for real applies; on --dry-run we
			// fall back to an empty snapshot if creds aren't usable, so
			// the operator can preview the plan offline.
			var client *cfapi.Client
			snap := plan.Snapshot{}
			if tok != "" && acct != "" {
				client = cfapi.NewClient(tok, acct)
				snap, err = LiveSnapshot(ctx, client)
				if err != nil {
					if !dryRun {
						return fmt.Errorf("snapshot live CF: %w", err)
					}
					fmt.Fprintf(cmd.ErrOrStderr(),
						"warning: live snapshot failed (%v) — dry-run continuing against state alone\n", err)
					snap = plan.Snapshot{}
				}
			}

			p := plan.Diff(plan.WithR2PublicDomain(plan.Desired(), cfg.R2PublicHost), doc, snap)
			plan.Render(cmd.OutOrStdout(), p)

			if !p.HasCreates() && len(p.Adopt) == 0 {
				fmt.Fprintln(cmd.OutOrStdout(), "\nnothing to do — state already matches desired.")
				return nil
			}

			if dryRun {
				fmt.Fprintln(cmd.OutOrStdout(), "\n--dry-run: stopping before any Cloudflare write.")
				return nil
			}

			// Confirm. --yes skips; non-interactive without --yes is a hard error.
			if !yes {
				if nonInteractive || !isInteractiveStdin() {
					return errors.New("refusing to proceed without --yes in non-interactive mode")
				}
				var confirm bool
				err := huh.NewConfirm().
					Title(fmt.Sprintf("Apply %d create(s) + %d adopt(s) to Cloudflare?",
						len(p.Creates), len(p.Adopt))).
					Affirmative("Yes, apply").
					Negative("Cancel").
					Value(&confirm).
					Run()
				if err != nil {
					return err
				}
				if !confirm {
					fmt.Fprintln(cmd.OutOrStdout(), "cancelled.")
					return nil
				}
			}

			// Pick a reporter: TUI for interactive runs (pretty
			// progress), plain stdout for CI / non-interactive.
			var reporter provision.Reporter
			if nonInteractive || !isInteractiveStdin() {
				reporter = provision.NewPlainReporter(cmd.OutOrStdout())
			} else {
				tr := newTUIReporter(cmd.OutOrStdout())
				reporter = tr
				defer tr.Done()
			}

			// Pass the optional Logpush HTTP-sink override from .env.deploy
			// through to provision. Empty means "use the auto-R2 path",
			// which is the documented default for zero-config Logpush.
			applyOpts := provision.ApplyOptions{
				LogpushHTTPSink: cfg.LogpushDestinationURL,
			}
			if err := provision.Apply(ctx, client, store, p, reporter, applyOpts); err != nil {
				return err
			}
			fmt.Fprintln(cmd.OutOrStdout(), "\nprovision complete — state written to", store.Path())
			return nil
		},
	}
	c.Flags().StringVar(&envFile, "env-file", defaultEnvFile, "path to .env.deploy")
	c.Flags().StringVar(&statePath, "state-path", "", "override .deploy-state.json path")
	c.Flags().StringVar(&token, "token", "", "Cloudflare API token (overrides $CF_API_TOKEN and .env.deploy)")
	c.Flags().StringVar(&accountID, "account-id", "", "Cloudflare account ID (overrides $CF_ACCOUNT_ID and .env.deploy)")
	c.Flags().BoolVar(&dryRun, "dry-run", false, "compute + print the plan but skip every Cloudflare write")
	c.Flags().BoolVarP(&yes, "yes", "y", false, "skip the confirmation prompt")
	c.Flags().BoolVar(&nonInteractive, "non-interactive", false, "force plain-stdout output (no TUI); requires --yes")
	return c
}

// isInteractiveStdin reports whether stdin is a TTY. We use this to
// decide between huh prompts (interactive) and the --yes-required
// non-interactive branch. The check is best-effort: containers without
// a TTY return false.
func isInteractiveStdin() bool {
	return isatty.IsTerminal(os.Stdin.Fd()) || isatty.IsCygwinTerminal(os.Stdin.Fd())
}
