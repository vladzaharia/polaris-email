package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

// newInfraCmd returns the `setup infra` parent. The bare command (no
// subcommand) prints a placeholder pointing operators at `make
// bootstrap` for now — PR 7 wires the full happy path.
func newInfraCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "infra",
		Short: "Provision + deploy the Cloudflare-side polaris-email infrastructure",
		Long: "Provision + deploy the Cloudflare-side polaris-email infrastructure.\n" +
			"\n" +
			"The bare `setup infra` command will (in PR 7) run the full happy path:\n" +
			"preflight → provision → render wrangler configs → migrate D1 →\n" +
			"seed secrets → deploy workers → mint admin key → smoke test.\n" +
			"\n" +
			"For PR 1, only the state-management subcommands are wired:\n" +
			"  setup infra state show       inspect the local .deploy-state.json\n" +
			"  setup infra state validate   check the schema version is current\n" +
			"  setup infra state rebuild    rebuild from a live Cloudflare account",
		RunE: func(cmd *cobra.Command, _ []string) error {
			fmt.Fprintln(cmd.OutOrStdout(),
				"not implemented yet — use `make bootstrap` for cold-start. PR 7 wires this up.")
			return nil
		},
	}
	// PR 2 leaves: preflight + configure.
	c.AddCommand(newInfraPreflightCmd())
	c.AddCommand(newInfraConfigureCmd())
	// PR 1 leaf: state subtree.
	c.AddCommand(newInfraStateCmd())
	c.AddCommand(newInfraRenderCmd())
	return c
}
