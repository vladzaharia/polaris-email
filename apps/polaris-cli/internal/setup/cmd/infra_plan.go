package cmd

import (
	"context"
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/output"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/cfapi"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/config"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/plan"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/state"
)

// newInfraPlanCmd wires `polaris-mail setup infra plan` — a
// read-only, terraform-style diff between Desired() and (state +
// live CF snapshot). Never writes.
//
// Inputs are loaded from .env.deploy (token + account ID) and
// .deploy-state.json. Both may be overridden with flags so CI runs
// can point at fixtures.
func newInfraPlanCmd() *cobra.Command {
	var (
		envFile   string
		statePath string
		outputFmt string
		token     string
		accountID string
		noLive    bool
	)
	c := &cobra.Command{
		Use:   "plan",
		Short: "Preview Cloudflare resource creates without making any changes",
		Long: "Compute a terraform-style diff between the constant desired state\n" +
			"(1 D1, 1 R2, 5 KV, 5 Queues) and the operator's current state\n" +
			"(.deploy-state.json + a live Cloudflare snapshot).\n" +
			"\n" +
			"This command is read-only — no Cloudflare resources are mutated,\n" +
			"and .deploy-state.json is not written. Use `setup infra apply`\n" +
			"to act on the plan.",
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			if ctx == nil {
				ctx = context.Background()
			}

			// Resolve token + account ID from flags → env → .env.deploy.
			cfg, _ := config.LoadOrDefault(envFile)
			tok, acct := resolveCFCreds(token, accountID, cfg)

			// Load state (may be empty on cold-start machines).
			store := state.Open(pickPath(statePath, defaultStatePath))
			doc, err := store.Read()
			if err != nil {
				return fmt.Errorf("read state: %w", err)
			}

			// Fetch a live snapshot from CF — unless --no-live is set
			// (handy for fixture-only CI), in which case we diff against
			// an empty snapshot. The result is that every state resource
			// shows up as Drift; every desired resource shows up as
			// Create.
			snap := plan.Snapshot{}
			if !noLive {
				if tok == "" || acct == "" {
					return fmt.Errorf("missing Cloudflare credentials (set CF_API_TOKEN + CF_ACCOUNT_ID, " +
						"or pass --token + --account-id, or use --no-live to diff against state only)")
				}
				client := cfapi.NewClient(tok, acct)
				snap, err = LiveSnapshot(ctx, client)
				if err != nil {
					return fmt.Errorf("snapshot live CF: %w", err)
				}
			}

			p := plan.Diff(plan.Desired(), doc, snap)

			// Render.
			f, err := output.ParseFormat(outputFmt)
			if err != nil {
				return err
			}
			w := cmd.OutOrStdout()
			switch f {
			case output.FormatJSON:
				return output.EmitJSON(w, p)
			case output.FormatYAML:
				return output.EmitYAML(w, p)
			default:
				plan.Render(w, p)
				return nil
			}
		},
	}
	c.Flags().StringVar(&envFile, "env-file", defaultEnvFile, "path to .env.deploy")
	c.Flags().StringVar(&statePath, "state-path", "", "override .deploy-state.json path")
	c.Flags().StringVarP(&outputFmt, "output", "o", "table", "output format: table|json|yaml")
	c.Flags().StringVar(&token, "token", "", "Cloudflare API token (overrides $CF_API_TOKEN and .env.deploy)")
	c.Flags().StringVar(&accountID, "account-id", "", "Cloudflare account ID (overrides $CF_ACCOUNT_ID and .env.deploy)")
	c.Flags().BoolVar(&noLive, "no-live", false, "skip the live CF snapshot; diff against state alone")
	return c
}

// resolveCFCreds picks the right (token, account) tuple from the three
// possible sources, preferring flags > env vars > .env.deploy.
//
// The env-var fallback accepts both CF_API_TOKEN and the legacy
// CLOUDFLARE_API_TOKEN spelling (used by the wrangler CLI). Same for
// the account ID.
func resolveCFCreds(flagToken, flagAccount string, cfg *config.Config) (string, string) {
	token := flagToken
	if token == "" {
		token = os.Getenv("CF_API_TOKEN")
	}
	if token == "" {
		token = os.Getenv("CLOUDFLARE_API_TOKEN")
	}
	if token == "" && cfg != nil {
		token = cfg.CFAPIToken
	}

	acct := flagAccount
	if acct == "" {
		acct = os.Getenv("CF_ACCOUNT_ID")
	}
	if acct == "" {
		acct = os.Getenv("CLOUDFLARE_ACCOUNT_ID")
	}
	if acct == "" && cfg != nil {
		acct = cfg.CFAccountID
	}
	return token, acct
}

// LiveSnapshot calls the four cfapi list endpoints and assembles a
// plan.Snapshot. Exported so the (build-tagged) integration test in
// the provision package can reuse the same code path the cmd does.
//
// R2 is queried in two passes (default + EU jurisdiction) so EU
// buckets aren't invisible. The list endpoints are paginated by the
// cfapi layer so callers don't need to worry about that.
func LiveSnapshot(ctx context.Context, c *cfapi.Client) (plan.Snapshot, error) {
	snap := plan.Snapshot{}

	dbs, err := c.ListDatabases(ctx)
	if err != nil {
		return snap, fmt.Errorf("list d1: %w", err)
	}
	for _, d := range dbs {
		snap.D1 = append(snap.D1, plan.LiveResource{ID: d.UUID, Name: d.Name})
	}

	seen := map[string]struct{}{}
	for _, jur := range []string{"", "eu"} {
		buckets, lerr := c.ListBuckets(ctx, jur)
		if lerr != nil {
			// EU may legitimately be empty / unauthorised on accounts
			// without EU buckets — treat 4xx as "no buckets here" so
			// the diff path can still proceed.
			if jur != "" && cfapi.IsNotFound(lerr) {
				continue
			}
			return snap, fmt.Errorf("list r2 (jur=%q): %w", jur, lerr)
		}
		for _, b := range buckets {
			if _, ok := seen[b.Name]; ok {
				continue
			}
			seen[b.Name] = struct{}{}
			snap.R2 = append(snap.R2, plan.LiveR2{Name: b.Name, Jurisdiction: b.Jurisdiction})
		}
	}

	ns, err := c.ListNamespaces(ctx)
	if err != nil {
		return snap, fmt.Errorf("list kv: %w", err)
	}
	for _, n := range ns {
		snap.KV = append(snap.KV, plan.LiveResource{ID: n.ID, Name: n.Title})
	}

	qs, err := c.ListQueues(ctx)
	if err != nil {
		return snap, fmt.Errorf("list queues: %w", err)
	}
	for _, q := range qs {
		snap.Queues = append(snap.Queues, plan.LiveResource{ID: q.QueueID, Name: q.QueueName})
	}

	return snap, nil
}
