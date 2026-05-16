// Package cmds wires the cobra command tree.
package cmds

import (
	"context"
	"fmt"
	"io"
	"os"

	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/config"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/output"
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
	root := &cobra.Command{
		Use:           "polaris-email",
		Short:         "polaris-email — operator CLI for the polaris-email control plane",
		Long:          "Operator CLI for polaris-email. The same binary is symlinked as `pml`.",
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	root.PersistentFlags().StringVar(&G.ConfigPath, "config", "", "config file (default ~/.config/polaris-email/config.toml)")
	root.PersistentFlags().StringVar(&G.Profile, "profile", "", "named profile in config file (default 'prod')")
	root.PersistentFlags().StringVar(&G.APIURL, "api-url", "", "override admin API base URL")
	root.PersistentFlags().StringVar(&G.Token, "token", "", "override admin API token (HMAC secret)")
	root.PersistentFlags().StringVar(&G.KeyID, "key-id", "", "override admin API key id")
	root.PersistentFlags().StringVarP(&G.OutputFmt, "output", "o", "table", "output format: table|json|yaml")
	root.PersistentFlags().BoolVar(&G.DryRun, "dry-run", false, "print API calls without executing them")

	root.AddCommand(
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
		newBootstrapCmd(),
		newSuppressionCmd(),
		newVersionCmd(),
	)
	return root
}

// MakeClient constructs a *client.Client using globals + config file.
//
// Resolution order for both api-url and token (highest priority first):
//
//  1. CLI flag (`--api-url` / `--token`)
//  2. Environment variable (`POLARIS_API_URL` / `POLARIS_TOKEN`)
//  3. Profile in the config file
//
// The empty-check happens *after* the env fallback so a `POLARIS_TOKEN` set
// in the shell is honored even when neither flag nor config file provides
// one.
func MakeClient() (*client.Client, error) {
	path := G.ConfigPath
	if path == "" {
		p, err := config.DefaultPath()
		if err != nil {
			return nil, err
		}
		path = p
	}
	// We try to load the config but don't hard-fail if it's missing — the
	// env vars + flags may carry everything we need.
	var prof config.Profile
	f, err := config.Load(path)
	if err == nil {
		if p, perr := f.Resolve(G.Profile); perr == nil {
			prof = p
		}
	}
	apiURL := G.APIURL
	if apiURL == "" {
		apiURL = os.Getenv("POLARIS_API_URL")
	}
	if apiURL == "" {
		apiURL = prof.APIURL
	}
	token := G.Token
	if token == "" {
		token = os.Getenv("POLARIS_TOKEN")
	}
	if token == "" {
		token = prof.Token
	}
	keyID := G.KeyID
	if keyID == "" {
		keyID = os.Getenv("POLARIS_KEY_ID")
	}
	if keyID == "" {
		keyID = prof.KeyID
	}
	if apiURL == "" {
		return nil, fmt.Errorf("no api-url configured (set --api-url, $POLARIS_API_URL, or write config file)")
	}
	if token == "" {
		return nil, fmt.Errorf("no token configured (set --token, $POLARIS_TOKEN, or write config file)")
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
