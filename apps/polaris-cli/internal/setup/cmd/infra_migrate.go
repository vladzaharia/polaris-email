package cmd

import (
	"context"
	"fmt"

	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/migrate"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/state"
)

// newInfraMigrateCmd wires `polaris-mail setup infra migrate`.
func newInfraMigrateCmd() *cobra.Command {
	var (
		dbName    string
		statePath string
		local     bool
		verbose   bool
		// to is accepted but unimplemented — the runtime returns an
		// error if set. wrangler supports `--to <filename>` to stop at
		// a specific migration, but the Go wrapper doesn't pass it
		// through today.
		to string
	)
	c := &cobra.Command{
		Use:   "migrate",
		Short: "Apply D1 migrations to the polaris-mail database",
		Long: "Shell out to `wrangler d1 migrations apply` to bring the D1\n" +
			"schema to the latest revision. Parses the result, records the\n" +
			"phase completion into .deploy-state.json, and prints a tidy\n" +
			"summary (count + latest migration filename).\n" +
			"\n" +
			"The cold-start runner calls this between secret seeding and\n" +
			"Worker deploy. Operators can also run it ad-hoc after adding a\n" +
			"new migration to services/api/migrations/.",
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			if ctx == nil {
				ctx = context.Background()
			}
			if to != "" {
				return fmt.Errorf("--to is accepted but unimplemented today")
			}
			store := state.Open(pickPath(statePath, defaultStatePath))
			res, err := migrate.Apply(ctx, dbName, !local, store)
			if err != nil {
				return err
			}
			w := cmd.OutOrStdout()
			if res.Applied == 0 {
				fmt.Fprintln(w, "migrate: schema is already current — no migrations to apply")
			} else {
				fmt.Fprintf(w, "migrate: applied %d migration(s); latest=%s\n", res.Applied, res.Latest)
			}
			if verbose {
				fmt.Fprintln(w, "--- wrangler output ---")
				fmt.Fprintln(w, res.Stdout)
			}
			return nil
		},
	}
	c.Flags().StringVar(&dbName, "db", "polaris-mail", "D1 database name")
	c.Flags().StringVar(&statePath, "state-path", "", "override .deploy-state.json path")
	c.Flags().BoolVar(&local, "local", false, "apply migrations to the local D1 binding instead of --remote")
	c.Flags().BoolVar(&verbose, "verbose", false, "include the raw wrangler output in the summary")
	c.Flags().StringVar(&to, "to", "", "stop at the named migration filename (accepted but unimplemented — returns an error today)")
	return c
}
