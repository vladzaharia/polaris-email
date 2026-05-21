// polaris-mail serve --ssh — runs the Wish-fronted TUI as an SSH server.
//
// The Wish server signs every outgoing API call with the bootstrap key
// supplied via flags (which must hold the `admin:impersonate` scope), and
// attributes the request to the connecting operator via the
// `X-Polaris-OBO` header.
package cmds

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/credstore"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/sshserver"
)

func newServeCmd() *cobra.Command {
	var (
		ssh            bool
		host           string
		port           int
		hostKey        string
		bootstrapToken string
		bootstrapKeyID string
		lookupTTL      time.Duration
		idleTimeout    time.Duration
		maxSessions    int
		themeName      string
	)
	c := &cobra.Command{
		Use:   "serve",
		Short: "Run polaris-mail as a long-running server (currently: SSH-fronted TUI)",
		Long: `Run the fullscreen tabbed TUI as an SSH server, fronted by Wish.

Operators SSH in with the same key registered via ` + "`polaris-mail operator add`" + `;
every action they take is attributed to their operator id in the audit log.

Setup is part of ` + "`polaris-mail setup infra`" + ` (which can mint the bootstrap
impersonation key for you); see ` + "`docs/operator.md`" + ` for the cold-start
sequence.`,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if !ssh {
				return errors.New("--ssh is required (reserved for future modes)")
			}
			// Resolve bootstrap credentials from flags / env / one-shot bearer.
			tok := bootstrapToken
			if tok == "" {
				tok = os.Getenv("POLARIS_BOOTSTRAP_TOKEN")
			}
			kid := bootstrapKeyID
			if kid == "" {
				kid = os.Getenv("POLARIS_BOOTSTRAP_KEY_ID")
			}
			if tok != "" && kid == "" {
				if parsedKID, parsedSecret, err := credstore.ParseBearer(tok); err == nil {
					kid = parsedKID
					tok = parsedSecret
				}
			}
			apiURL := G.APIURL
			if apiURL == "" {
				apiURL = os.Getenv("POLARIS_API_URL")
			}
			if apiURL == "" {
				return errors.New("--api-url required (or set $POLARIS_API_URL)")
			}
			if kid == "" || tok == "" {
				return errors.New("set --bootstrap-token (polaris_{kid}.{secret}) or --bootstrap-key-id + --bootstrap-token (raw secret)")
			}
			boot := client.New(strings.TrimRight(apiURL, "/"), kid, tok)
			return sshserver.Run(cmd.Context(), sshserver.Config{
				Host: host, Port: port, HostKeyPath: hostKey,
				Bootstrap: boot,
				LookupTTL: lookupTTL, IdleTimeout: idleTimeout, MaxSessions: maxSessions,
				Theme: themeName,
			})
		},
	}
	c.Flags().BoolVar(&ssh, "ssh", false, "enable the SSH server")
	c.Flags().StringVar(&host, "host", "", "bind address (default: any)")
	c.Flags().IntVar(&port, "port", 2222, "bind port")
	c.Flags().StringVar(&hostKey, "host-key", "", "path to host key (auto-generates ED25519 if missing)")
	c.Flags().StringVar(&bootstrapToken, "bootstrap-token", "", "bootstrap bearer (polaris_{kid}.{secret}; admin:impersonate scope)")
	c.Flags().StringVar(&bootstrapKeyID, "bootstrap-key-id", "", "(legacy split form) bootstrap api_key id")
	c.Flags().DurationVar(&lookupTTL, "lookup-cache-ttl", 5*time.Minute, "in-process cache TTL for fingerprint→operator lookups")
	c.Flags().DurationVar(&idleTimeout, "idle-timeout", 30*time.Minute, "SSH session idle timeout")
	c.Flags().IntVar(&maxSessions, "max-sessions", 64, "max concurrent SSH sessions")
	c.Flags().StringVar(&themeName, "theme", "macchiato", "TUI theme")
	// Hide internal usage hint when a friendlier error from RunE fires.
	c.SilenceUsage = true
	_ = fmt.Sprintf // keep imports stable if a future flag uses fmt directly
	return c
}
