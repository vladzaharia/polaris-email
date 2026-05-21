// Bubble Tea handler — per-SSH-session: copies the bootstrap client,
// injects the `X-Polaris-OBO` header for the connecting operator,
// and constructs a TUI program bound to that operator.
package sshserver

import (
	"github.com/charmbracelet/ssh"
	"github.com/charmbracelet/wish/bubbletea"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/muesli/termenv"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
	tuiapp "github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/tui/app"
)

// newProgramHandler returns a wish.bubbletea.ProgramHandler that hands
// each SSH session its own per-operator-bound tea.Program.
//
// The bootstrap client signs requests; the impersonation header attributes
// every API call to the connecting operator. The TUI itself doesn't know
// it's running under SSH — same code path as `polaris-mail tui` locally.
func newProgramHandler(bootstrap *client.Client, themeName string) bubbletea.ProgramHandler {
	return func(sess ssh.Session) *tea.Program {
		op := OperatorFromContext(sess.Context())
		// Shallow-copy bootstrap client so the OBO header is per-session.
		// Bytes of Secret are shared (no mutation); we don't need a deep copy.
		sdkCopy := *bootstrap
		sdkCopy.UserAgent = bootstrap.UserAgent + " (ssh:" + op.Email + ")"
		// Override the per-session HTTP request builder by stashing a
		// pre-baked client that always adds the OBO header. We do this by
		// wrapping the existing *http.Client with a transport that injects
		// the header on every request.
		sdkCopy.HTTPClient = withImpersonation(bootstrap, op.ID)

		ident := tuiapp.Identity{OperatorID: op.ID, Email: op.Email}
		p := tuiapp.NewProgram(tuiapp.ProgramOpts{
			Ctx:       sess.Context(),
			Client:    &sdkCopy,
			Identity:  ident,
			Theme:     themeName,
			In:        sess,
			Out:       sess,
			AltScreen: true,
			Extra:     bubbletea.MakeOptions(sess),
		})
		_ = termenv.NewOutput(sess) // hint: tea will pick the right profile via MakeOptions
		return p
	}
}
