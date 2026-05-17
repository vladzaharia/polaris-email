// polaris-email tui — launch the fullscreen tabbed admin TUI locally.
//
// Also wired as the no-args RunE on the root command, so `polaris-email`
// with no positional args opens the TUI when stdout is a TTY; otherwise
// it falls back to printing help (so piping `polaris-email | head` doesn't
// drop into an interactive UI).
package cmds

import (
	"os"

	"github.com/mattn/go-isatty"
	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/credstore"
	tuiapp "github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/tui/app"
)

func newTUICmd() *cobra.Command {
	var themeName string
	c := &cobra.Command{
		Use:   "tui",
		Short: "Launch the fullscreen tabbed admin TUI",
		Long: `Open the interactive admin TUI: a tabbed view of Dashboard,
Mailboxes, Domains, Credentials, Webhooks/DLQ, Bridges, Audit, and Logs.

Identity comes from your credstore profile (` + "`polaris-email login`" + `).
Same view is served over SSH by ` + "`polaris-email serve --ssh`" + ` (Wish).`,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runTUI(cmd, themeName)
		},
	}
	c.Flags().StringVar(&themeName, "theme", "macchiato", "macchiato|mocha|frappe|latte")
	return c
}

// runTUI is shared between the explicit `tui` subcommand and the no-args
// path. It guards on a TTY because hopping into alt-screen on a piped
// stdout corrupts downstream consumers.
func runTUI(cmd *cobra.Command, themeName string) error {
	if !isatty.IsTerminal(os.Stdout.Fd()) {
		return cmd.Help()
	}
	cl, err := MakeClient()
	if err != nil {
		return err
	}
	// Cached operator identity (best effort; the TUI shows email in the
	// status bar). The credstore was already consulted by MakeClient.
	ident := tuiapp.Identity{}
	if cred := lookupActiveCredstoreEntry(); cred != nil {
		ident.OperatorID = cred.OperatorID
		ident.Email = cred.Email
	}
	p := tuiapp.NewProgram(tuiapp.ProgramOpts{
		Ctx:       cmd.Context(),
		Client:    cl,
		Identity:  ident,
		Theme:     themeName,
		In:        os.Stdin,
		Out:       os.Stdout,
		AltScreen: true,
	})
	_, err = p.Run()
	return err
}

// lookupActiveCredstoreEntry returns the operator profile cached for the
// active --profile (or "default"). Returns nil on any error — the TUI's
// status bar simply omits the email line in that case.
func lookupActiveCredstoreEntry() *credstore.Credential {
	store, err := credstore.New()
	if err != nil {
		return nil
	}
	profile := G.Profile
	if profile == "" {
		profile = "default"
	}
	cred, err := store.Load(profile)
	if err != nil {
		return nil
	}
	return cred
}
