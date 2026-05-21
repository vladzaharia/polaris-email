package cmd

import (
	"context"
	"errors"
	"fmt"

	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/cfapi"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/config"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/deploy"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/state"
)

// newInfraResetCmd wires `polaris-mail setup infra reset`. Subcommands
// destroy specific CF resources and clear their entries from
// .deploy-state.json so the next `setup infra apply` recreates them
// fresh. Used for greenfield wipe-and-restart in dev/staging.
func newInfraResetCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "reset",
		Short: "Destroy a provisioned resource so apply can recreate it (greenfield wipe-and-restart)",
		Long: "reset deletes a Cloudflare resource (D1, KV, R2, queue, etc.)\n" +
			"and clears its entry from .deploy-state.json. A subsequent\n" +
			"`setup infra apply` will recreate the resource from desired\n" +
			"state. Each subcommand requires explicit `--yes` (or an\n" +
			"interactive type-the-resource-name confirmation) because the\n" +
			"operation is destructive.\n" +
			"\n" +
			"Use cases:\n" +
			"  - Wiping a D1 database after a schema rewrite (the common one).\n" +
			"  - Recovering from a partial bootstrap that left state in a bad shape.",
	}
	c.AddCommand(newInfraResetD1Cmd())
	c.AddCommand(newInfraResetAllCmd())
	return c
}

// newInfraResetAllCmd wires `polaris-mail setup infra reset all`.
//
// Walks .deploy-state.json and deletes every CF resource it references
// (D1, R2 buckets, R2 API tokens, KV namespaces, queues, Logpush jobs),
// then wipes the state file so the next `setup infra apply` provisions
// the stack from scratch.
//
// Caveats:
//   - R2 buckets must be empty for CF to delete them. The command
//     surfaces CF's error if any bucket has objects; the operator wipes
//     with `wrangler r2 object delete` or via the dashboard before
//     re-running.
//   - Bootstrap Worker secrets (POLARIS_SECRET_A, ARGON2_PEPPER) are NOT
//     removed — they're per-Worker, untracked in state, and harmless to
//     leave. The next genesis-seal regenerates them as needed.
//   - Destructive. No undo.
func newInfraResetAllCmd() *cobra.Command {
	var (
		envFile   string
		statePath string
		yes       bool
	)
	c := &cobra.Command{
		Use:   "all",
		Short: "Destroy every CF resource recorded in state and wipe state (greenfield restart)",
		Long: "Walks .deploy-state.json and deletes every Cloudflare resource\n" +
			"it references (D1, R2 buckets + tokens, KV, queues, Logpush\n" +
			"jobs). Wipes the state file's resource maps + phase markers so\n" +
			"the next `setup infra apply` provisions the stack from scratch.\n" +
			"\n" +
			"Use this only on greenfield/staging environments. There is no\n" +
			"undo. R2 buckets must be empty for CF to delete them — wipe\n" +
			"objects first if needed.",
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			if ctx == nil {
				ctx = context.Background()
			}

			cfg, _ := config.LoadOrDefault(envFile)
			tok, acct := resolveCFCreds("", "", cfg)
			if tok == "" || acct == "" {
				return errors.New("reset all: missing CF_API_TOKEN + CF_ACCOUNT_ID")
			}

			store := state.Open(pickPath(statePath, defaultStatePath))
			doc, err := store.Read()
			if err != nil {
				return fmt.Errorf("read state: %w", err)
			}

			total := len(doc.D1) + len(doc.R2) + len(doc.R2Tokens) +
				len(doc.KV) + len(doc.Queues) + len(doc.LogpushJobs)
			if total == 0 {
				fmt.Fprintln(cmd.OutOrStdout(), "reset all: state has no recorded resources — nothing to do")
				return nil
			}

			out := cmd.OutOrStdout()
			fmt.Fprintf(out, "reset all: about to delete %d resources from Cloudflare account %s:\n", total, acct)
			for n := range doc.D1 {
				fmt.Fprintf(out, "  D1       %s\n", n)
			}
			for n := range doc.R2 {
				fmt.Fprintf(out, "  R2       %s\n", n)
			}
			for n := range doc.R2Tokens {
				fmt.Fprintf(out, "  R2 token %s\n", n)
			}
			for n := range doc.KV {
				fmt.Fprintf(out, "  KV       %s\n", n)
			}
			for n := range doc.Queues {
				fmt.Fprintf(out, "  Queue    %s\n", n)
			}
			for n := range doc.LogpushJobs {
				fmt.Fprintf(out, "  Logpush  %s\n", n)
			}

			if !yes {
				if !isInteractiveStdin() {
					return errors.New("reset all: refusing to destroy without --yes in non-interactive mode")
				}
				const confirmPhrase = "destroy everything"
				var typed string
				err := huh.NewInput().
					Title("Destroy the entire stack?").
					Description(fmt.Sprintf("Type %q to confirm:", confirmPhrase)).
					Value(&typed).
					Run()
				if err != nil {
					return err
				}
				if typed != confirmPhrase {
					return errors.New("reset all: confirmation did not match — aborted")
				}
			}

			client := cfapi.NewClient(tok, acct)
			anyFailed := false

			// Reverse-dependency order:
			//   1. Queue consumer bindings — CF refuses to delete a Worker
			//      that's a queue consumer, AND refuses to delete a queue
			//      that has consumers. Detach the consumers first so both
			//      sides can come down later.
			//   2. Queue DLQ references    — CF refuses to delete a DLQ
			//      that other queues reference. Unset the dlq pointer on
			//      every queue that has one.
			//   3. Workers Custom Domains  — independent CF resources that
			//      reference Workers by name. Deleting a Worker does NOT
			//      auto-detach them, and a stale custom domain on a
			//      hostname blocks re-binding it on the next deploy.
			//   4. Workers themselves      — now allowed (no longer consumers).
			//   5. Logpush                  — refs R2 + token.
			//   6. R2 tokens.
			//   7. R2 buckets.
			//   8. KV namespaces.
			//   9. Queues                   — now allowed (no consumers, no dlq refs).
			//  10. D1 databases.

			// 1. Detach queue consumers from every recorded queue.
			emptyStr := ""
			for n, rec := range doc.Queues {
				if rec.ID == "" {
					continue
				}
				consumers, err := client.ListQueueConsumers(ctx, rec.ID)
				if err != nil {
					fmt.Fprintf(out, "  ✘ List consumers on Queue %s: %v\n", n, err)
					anyFailed = true
					continue
				}
				for _, csm := range consumers {
					if err := client.DeleteQueueConsumer(ctx, rec.ID, csm.ConsumerID); err != nil {
						fmt.Fprintf(out, "  ✘ Detach consumer %s (%s) from Queue %s: %v\n",
							csm.ConsumerID, csm.Script, n, err)
						anyFailed = true
						continue
					}
					fmt.Fprintf(out, "  ✓ Detached consumer %s (%s) from Queue %s\n",
						csm.ConsumerID, csm.Script, n)
				}
			}

			// 2. Unset DLQ pointer on every recorded queue (idempotent —
			//    if the queue never had a dlq, this is a no-op PATCH).
			for n, rec := range doc.Queues {
				if rec.ID == "" {
					continue
				}
				if err := client.PatchQueue(ctx, rec.ID, cfapi.QueueSettings{DeadLetterQueue: &emptyStr}); err != nil {
					// PATCH on a queue without a DLQ should be harmless;
					// surface the error but don't bail. The downstream
					// queue-delete loop will report the real blocker if
					// the DLQ stays bound.
					fmt.Fprintf(out, "  ✘ Clear DLQ on Queue %s: %v\n", n, err)
					anyFailed = true
					continue
				}
				fmt.Fprintf(out, "  ✓ Cleared DLQ binding on Queue %s\n", n)
			}

			// Build a name-set for our canonical Workers so we only delete
			// custom domains we own (not any unrelated Worker on the account).
			ourScripts := map[string]bool{}
			for _, svc := range deploy.Services {
				ourScripts["polaris-mail-"+svc.Name] = true
			}
			domains, err := client.ListWorkerCustomDomains(ctx)
			if err != nil {
				fmt.Fprintf(out, "  ✘ List Worker Custom Domains: %v\n", err)
				anyFailed = true
			} else {
				for _, d := range domains {
					if !ourScripts[d.Service] {
						continue
					}
					if err := client.DeleteWorkerCustomDomain(ctx, d.ID); err != nil {
						fmt.Fprintf(out, "  ✘ Workers Custom Domain %s (→ %s): %v\n", d.Hostname, d.Service, err)
						anyFailed = true
						continue
					}
					fmt.Fprintf(out, "  ✓ Workers Custom Domain %s (→ %s)\n", d.Hostname, d.Service)
				}
			}

			for _, svc := range deploy.Services {
				workerName := "polaris-mail-" + svc.Name
				if err := client.DeleteScript(ctx, workerName); err != nil {
					fmt.Fprintf(out, "  ✘ Worker %s: %v\n", workerName, err)
					anyFailed = true
					continue
				}
				fmt.Fprintf(out, "  ✓ Worker %s\n", workerName)
			}
			for n, rec := range doc.LogpushJobs {
				if rec.ID == 0 {
					continue
				}
				if err := client.DeleteLogpushJob(ctx, rec.ID); err != nil {
					fmt.Fprintf(out, "  ✘ Logpush %s: %v\n", n, err)
					anyFailed = true
					continue
				}
				fmt.Fprintf(out, "  ✓ Logpush %s\n", n)
				delete(doc.LogpushJobs, n)
			}
			for n, rec := range doc.R2Tokens {
				if rec.ID == "" {
					continue
				}
				if err := client.DeleteR2APIToken(ctx, rec.ID); err != nil {
					fmt.Fprintf(out, "  ✘ R2 token %s: %v\n", n, err)
					anyFailed = true
					continue
				}
				fmt.Fprintf(out, "  ✓ R2 token %s\n", n)
				delete(doc.R2Tokens, n)
			}
			for n, rec := range doc.R2 {
				if err := client.DeleteBucket(ctx, rec.Name, rec.Jurisdiction); err != nil {
					fmt.Fprintf(out, "  ✘ R2 %s: %v\n", n, err)
					anyFailed = true
					continue
				}
				fmt.Fprintf(out, "  ✓ R2 %s\n", n)
				delete(doc.R2, n)
			}
			for n, rec := range doc.KV {
				if rec.ID == "" {
					continue
				}
				if err := client.DeleteNamespace(ctx, rec.ID); err != nil {
					fmt.Fprintf(out, "  ✘ KV %s: %v\n", n, err)
					anyFailed = true
					continue
				}
				fmt.Fprintf(out, "  ✓ KV %s\n", n)
				delete(doc.KV, n)
			}
			for n, rec := range doc.Queues {
				if rec.ID == "" {
					continue
				}
				if err := client.DeleteQueue(ctx, rec.ID); err != nil {
					fmt.Fprintf(out, "  ✘ Queue %s: %v\n", n, err)
					anyFailed = true
					continue
				}
				fmt.Fprintf(out, "  ✓ Queue %s\n", n)
				delete(doc.Queues, n)
			}
			for n, rec := range doc.D1 {
				if rec.ID == "" {
					continue
				}
				if err := client.DeleteDatabase(ctx, rec.ID); err != nil {
					fmt.Fprintf(out, "  ✘ D1 %s: %v\n", n, err)
					anyFailed = true
					continue
				}
				fmt.Fprintf(out, "  ✓ D1 %s\n", n)
				delete(doc.D1, n)
			}

			// Reset phase markers + deploys so a fresh setup infra runs cleanly.
			doc.Phases = map[string]state.Phase{}
			doc.Deploys = nil

			unlock, err := store.Lock(true)
			if err != nil {
				return fmt.Errorf("lock state: %w", err)
			}
			defer func() { _ = unlock() }()
			if err := store.Write(doc); err != nil {
				return fmt.Errorf("write state: %w", err)
			}

			if anyFailed {
				fmt.Fprintln(out, "\nreset all: some resources failed to delete — see above. State updated for resources that did delete.")
				return errors.New("reset all: partial failure")
			}
			fmt.Fprintln(out, "\nreset all: stack destroyed. Run `polaris-mail setup infra` to recreate.")
			return nil
		},
	}
	c.Flags().StringVar(&envFile, "env-file", defaultEnvFile, "path to .env.deploy")
	c.Flags().StringVar(&statePath, "state-path", "", "override .deploy-state.json path")
	c.Flags().BoolVarP(&yes, "yes", "y", false, "skip the type-the-phrase confirmation prompt")
	return c
}

// newInfraResetD1Cmd wires `polaris-mail setup infra reset d1`.
func newInfraResetD1Cmd() *cobra.Command {
	var (
		envFile   string
		statePath string
		dbName    string
		yes       bool
	)
	c := &cobra.Command{
		Use:   "d1",
		Short: "Delete the polaris-mail D1 database and clear it from state",
		Long: "Deletes the named D1 database from Cloudflare and removes its\n" +
			"entry from .deploy-state.json. The next `setup infra apply`\n" +
			"will recreate the database from desired state, and a\n" +
			"subsequent `setup infra migrate` will apply 0001_init from\n" +
			"scratch.\n" +
			"\n" +
			"This is intended for greenfield environments only. Running it\n" +
			"against a production D1 deletes every row irrevocably — Time\n" +
			"Travel cannot recover a deleted database (only point-in-time\n" +
			"states of an existing one).",
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			if ctx == nil {
				ctx = context.Background()
			}

			cfg, _ := config.LoadOrDefault(envFile)
			tok, acct := resolveCFCreds("", "", cfg)
			if tok == "" || acct == "" {
				return errors.New("reset d1: missing CF_API_TOKEN + CF_ACCOUNT_ID")
			}

			store := state.Open(pickPath(statePath, defaultStatePath))
			doc, err := store.Read()
			if err != nil {
				return fmt.Errorf("read state: %w", err)
			}
			rec, ok := doc.D1[dbName]
			if !ok {
				fmt.Fprintf(cmd.OutOrStdout(),
					"reset d1: %q is not recorded in .deploy-state.json — nothing to do\n", dbName)
				return nil
			}
			if rec.ID == "" {
				return fmt.Errorf("reset d1: state has %q but no UUID — cannot identify the live database", dbName)
			}

			// Confirm.
			if !yes {
				if !isInteractiveStdin() {
					return errors.New("reset d1: refusing to delete without --yes in non-interactive mode")
				}
				var typed string
				err := huh.NewInput().
					Title(fmt.Sprintf("Delete D1 database %q (uuid %s)?", dbName, rec.ID)).
					Description(fmt.Sprintf("Type the database name (%s) to confirm:", dbName)).
					Value(&typed).
					Run()
				if err != nil {
					return err
				}
				if typed != dbName {
					return errors.New("reset d1: confirmation did not match — aborted")
				}
			}

			client := cfapi.NewClient(tok, acct)
			if err := client.DeleteDatabase(ctx, rec.ID); err != nil {
				return fmt.Errorf("delete D1: %w", err)
			}

			// Clear state under a write lock so concurrent runs don't race.
			unlock, err := store.Lock(true)
			if err != nil {
				return fmt.Errorf("lock state: %w", err)
			}
			defer func() { _ = unlock() }()
			doc, err = store.Read()
			if err != nil {
				return fmt.Errorf("re-read state: %w", err)
			}
			delete(doc.D1, dbName)
			// Also reset the migrate phase marker so the next happy-path
			// resume reapplies migrations.
			if doc.Phases != nil {
				delete(doc.Phases, "migrate")
				delete(doc.Phases, "apply")
			}
			if err := store.Write(doc); err != nil {
				return fmt.Errorf("write state: %w", err)
			}

			fmt.Fprintf(cmd.OutOrStdout(),
				"reset d1: deleted database %q (uuid %s) from Cloudflare and cleared state.\n"+
					"Run `polaris-mail setup infra apply` to recreate, then `polaris-mail setup infra migrate` to apply migrations.\n",
				dbName, rec.ID)
			return nil
		},
	}
	c.Flags().StringVar(&envFile, "env-file", defaultEnvFile, "path to .env.deploy")
	c.Flags().StringVar(&statePath, "state-path", "", "override .deploy-state.json path")
	c.Flags().StringVar(&dbName, "db", "polaris-mail", "logical D1 database name to delete")
	c.Flags().BoolVarP(&yes, "yes", "y", false, "skip the type-the-name confirmation prompt")
	return c
}
