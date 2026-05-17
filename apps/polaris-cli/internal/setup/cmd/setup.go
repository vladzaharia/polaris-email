// Package cmd holds the cobra plumbing for the `polaris-email setup`
// command tree. Subcommands are wired in here and from sibling files;
// the root cmds package in `internal/cmds` just calls NewSetupCmd() to
// attach the tree.
//
// The setup tree lives in its own package (not under internal/cmds) so
// the implementation can mature independently — provisioning, plan,
// preflight, etc. all become children of this package without crowding
// the day-to-day operator commands.
package cmd

import (
	"github.com/spf13/cobra"
)

// NewSetupCmd returns the `setup` parent command. PR 1 wires only the
// `infra` subtree; PR 8 will add `bridge`.
func NewSetupCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "setup",
		Short: "Cold-start + ongoing deploy orchestration for polaris-email",
		Long: "Cold-start and ongoing deploy orchestration for polaris-email.\n" +
			"\n" +
			"Subcommands replace the legacy bin/*.sh scripts and the root Makefile\n" +
			"orchestration targets. See `polaris-email setup infra --help`.",
	}
	c.AddCommand(newInfraCmd())
	return c
}
