// Package cmds wires the cobra command tree.
package cmds

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/config"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/credstore"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/output"
	setupcmd "github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/cmd"
)

// Globals holds flags shared across every subcommand.
type Globals struct {
	ConfigPath string
	Profile    string
	APIURL     string
	Token      string
	KeyID      string
	OutputFmt  string
	DryRun     bool
}

// G is a singleton — cobra invokes commands serially so a global is fine here.
var G = &Globals{}

// Out is the writer all commands print to. Tests redirect this.
var Out io.Writer = os.Stdout

// Errw is the error writer.
var Errw io.Writer = os.Stderr

// NewRoot constructs the root cobra.Command and attaches every subcommand.
func NewRoot() *cobra.Command {
	var themeName string
	root := &cobra.Command{
		Use:   "polaris-email",
		Short: "polaris-email — operator CLI for the polaris-email control plane",
		Long: `Operator CLI for polaris-email. The same binary is symlinked as ` + "`pml`" + `.

With no arguments (and a TTY on stdout), opens the fullscreen tabbed admin
TUI — same as running ` + "`polaris-email tui`" + `. The TUI is also embeddable
under Wish (` + "`polaris-email serve --ssh`" + `).`,
		SilenceUsage:  true,
		SilenceErrors: true,
		Args:          cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runTUI(cmd, themeName)
		},
	}
	root.PersistentFlags().StringVar(&themeName, "theme", "macchiato", "TUI theme: macchiato|mocha|frappe|latte")
	root.PersistentFlags().StringVar(&G.ConfigPath, "config", "", "config file (default ~/.config/polaris-email/config.toml)")
	root.PersistentFlags().StringVar(&G.Profile, "profile", "", "named profile in config file (default 'prod')")
	root.PersistentFlags().StringVar(&G.APIURL, "api-url", "", "override admin API base URL")
	root.PersistentFlags().StringVar(&G.Token, "token", "", "override admin API token (HMAC secret)")
	root.PersistentFlags().StringVar(&G.KeyID, "key-id", "", "override admin API key id")
	root.PersistentFlags().StringVarP(&G.OutputFmt, "output", "o", "table", "output format: table|json|yaml")
	var jsonAlias bool
	root.PersistentFlags().BoolVar(&jsonAlias, "json", false, "shorthand for --output=json")
	root.PersistentPreRun = func(_ *cobra.Command, _ []string) {
		if jsonAlias {
			G.OutputFmt = "json"
		}
	}
	root.PersistentFlags().BoolVar(&G.DryRun, "dry-run", false, "print API calls without executing them")

	root.AddCommand(
		newTUICmd(),
		newServeCmd(),
		newLoginCmd(),
		newLogoutCmd(),
		newWhoamiCmd(),
		newProfileCmd(),
		newOperatorCmd(),
		newDomainCmd(),
		newZoneCmd(),
		newCFZoneCmd(),
		newBridgeCmd(),
		newRouteCmd(),
		newCredCmd(),
		newWebhookCmd(),
		newStatusCmd(),
		newAuditCmd(),
		newAuthCmd(),
		newSuppressionCmd(),
		newPolicyCmd(),
		setupcmd.NewSetupCmd(setupcmd.Options{
			CLIVersion: Version,
			MakeClient: MakeClient,
		}),
		newVersionCmd(),
	)
	return root
}

// MakeClient constructs a *client.Client.
//
// Resolution order (highest priority first):
//   1. CLI flag (`--token` / `--api-url` / `--key-id`)
//   2. Environment variable (`POLARIS_TOKEN` / `POLARIS_API_URL` / `POLARIS_KEY_ID`)
//   3. OS keychain credstore entry for the active --profile (or "default")
//   4. Legacy config.toml profile
//
// The token format accepted by `--token` / `$POLARIS_TOKEN` is either the
// bundled bearer `polaris_{key_id}.{secret}` (preferred) OR the raw secret
// with `--key-id` / `$POLARIS_KEY_ID` set separately (legacy).
func MakeClient() (*client.Client, error) {
	apiURL := G.APIURL
	if apiURL == "" {
		apiURL = os.Getenv("POLARIS_API_URL")
	}
	token := G.Token
	if token == "" {
		token = os.Getenv("POLARIS_TOKEN")
	}
	keyID := G.KeyID
	if keyID == "" {
		keyID = os.Getenv("POLARIS_KEY_ID")
	}

	// If the operator passed a bundled bearer, split it.
	if token != "" && keyID == "" {
		if kid, secret, err := credstore.ParseBearer(token); err == nil {
			keyID = kid
			token = secret
		}
	}

	// Credstore lookup (only when no token was provided via flag/env).
	if G.Token == "" && os.Getenv("POLARIS_TOKEN") == "" && (token == "" || keyID == "" || apiURL == "") {
		store, err := credstore.New()
		if err == nil {
			activeProfile := G.Profile
			if activeProfile == "" {
				activeProfile = "default"
			}
			cred, lerr := store.Load(activeProfile)
			if lerr == nil && cred != nil {
				if token == "" {
					token = cred.Secret
				}
				if keyID == "" {
					keyID = cred.KeyID
				}
				if apiURL == "" {
					apiURL = cred.APIURL
				}
			} else if lerr != nil && !errors.Is(lerr, credstore.ErrNotFound) {
				return nil, fmt.Errorf("credstore: %w", lerr)
			}
		}
	}

	// Legacy config.toml fallback.
	if token == "" || keyID == "" || apiURL == "" {
		path := G.ConfigPath
		if path == "" {
			if p, err := config.DefaultPath(); err == nil {
				path = p
			}
		}
		if path != "" {
			if f, err := config.Load(path); err == nil {
				if prof, perr := f.Resolve(G.Profile); perr == nil {
					if apiURL == "" {
						apiURL = prof.APIURL
					}
					if token == "" {
						token = prof.Token
					}
					if keyID == "" {
						keyID = prof.KeyID
					}
				}
			}
		}
	}

	if apiURL == "" {
		return nil, fmt.Errorf("no api-url configured (set --api-url, $POLARIS_API_URL, or run `polaris-email login`)")
	}
	if token == "" {
		return nil, fmt.Errorf("no token configured (set --token, $POLARIS_TOKEN, or run `polaris-email login`)")
	}
	c := client.New(apiURL, keyID, token)
	c.DryRun = G.DryRun
	c.DryRunSink = Out
	return c, nil
}

// Format returns the parsed output.Format.
func Format() output.Format {
	f, _ := output.ParseFormat(G.OutputFmt)
	return f
}

// Emit writes v according to the requested output format. For the table form,
// the caller is expected to pre-render the table itself; this helper is for
// JSON/YAML.
func Emit(v any) error {
	switch Format() {
	case output.FormatJSON:
		return output.EmitJSON(Out, v)
	case output.FormatYAML:
		return output.EmitYAML(Out, v)
	}
	// Fallback: JSON when the caller didn't supply a table.
	return output.EmitJSON(Out, v)
}

// EmitTable renders the given table when format is table; otherwise emits the
// supplied v as JSON/YAML.
func EmitTable(t *output.Table, v any) error {
	if Format() == output.FormatTable {
		return t.Render(Out)
	}
	return Emit(v)
}

// CtxBackground returns a fresh context. Centralized so we can later add
// per-command timeouts.
func CtxBackground() context.Context { return context.Background() }
