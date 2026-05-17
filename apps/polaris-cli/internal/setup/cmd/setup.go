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

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
)

// Options is the dependency-injection point the root cmds package
// passes to NewSetupCmd. Carrying these via Options (instead of a
// reverse import of internal/cmds) breaks the import cycle that would
// otherwise form: internal/cmds → internal/setup/cmd → internal/cmds.
type Options struct {
	// CLIVersion is the compiled-in version string (cmds.Version).
	// Used to pin the bridge image tag and stamp generated files.
	CLIVersion string

	// MakeClient mints an authenticated admin API client. nil is
	// permitted — leaves that need a client surface a clear error
	// when one is unavailable.
	MakeClient func() (*client.Client, error)
}

// NewSetupCmd returns the `setup` parent command. PR 1 wired only the
// `infra` subtree; PR 9 adds `bridge`.
func NewSetupCmd(opts Options) *cobra.Command {
	c := &cobra.Command{
		Use:   "setup",
		Short: "Cold-start + ongoing deploy orchestration for polaris-email",
		Long: "Cold-start and ongoing deploy orchestration for polaris-email.\n" +
			"\n" +
			"Subcommands replace the legacy bin/*.sh scripts and the root Makefile\n" +
			"orchestration targets. See `polaris-email setup infra --help`\n" +
			"and `polaris-email setup bridge --help`.",
	}
	c.AddCommand(newInfraCmd(), newSetupBridgeCmd(opts))
	return c
}
