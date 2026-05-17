// polaris-email login / logout / whoami / profile — unified operator-session
// management for the CLI and TUI.
package cmds

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/credstore"
)

func newLoginCmd() *cobra.Command {
	var (
		apiURL  string
		method  string
		token   string
		profile string
	)
	c := &cobra.Command{
		Use:   "login",
		Short: "Sign in as an operator (paste a login token; stored encrypted in the OS keychain)",
		Long: `Sign in as an operator. The "token" is the polaris_{key_id}.{secret}
bearer printed by ` + "`polaris-email operator add`" + `.

Storage: OS keychain when available (macOS Keychain, Linux Secret Service /
KWallet, Windows Credential Manager); falls back to a passphrase-encrypted
file under ~/.config/polaris-email/keyring/ on headless hosts.

Bootstrap/root tokens are refused — only tokens linked to an operator row
(via ` + "`polaris-email operator add`" + `) may log in. The bootstrap key can
still be used via --token / $POLARIS_TOKEN for one-shot operator-minting
workflows; it just can't be stored in the credstore.`,
		RunE: func(_ *cobra.Command, _ []string) error {
			activeProfile := profile
			if activeProfile == "" {
				activeProfile = "default"
			}
			if apiURL == "" {
				apiURL = G.APIURL
			}
			if apiURL == "" {
				apiURL = os.Getenv("POLARIS_API_URL")
			}
			if apiURL == "" {
				return errors.New("--api-url required (or set $POLARIS_API_URL)")
			}
			apiURL = strings.TrimRight(apiURL, "/")

			bearer := token
			switch method {
			case "", "paste":
				if bearer == "" {
					if err := huh.NewForm(huh.NewGroup(
						huh.NewInput().
							Title("Paste your operator login token").
							Description("Format: polaris_<key_id>.<secret>").
							EchoMode(huh.EchoModePassword).
							Value(&bearer),
					)).Run(); err != nil {
						return err
					}
				}
			case "stdin":
				if bearer == "" {
					var buf [4096]byte
					n, err := os.Stdin.Read(buf[:])
					if err != nil {
						return fmt.Errorf("read stdin: %w", err)
					}
					bearer = strings.TrimSpace(string(buf[:n]))
				}
			default:
				return fmt.Errorf("unknown --method %q (want paste|stdin)", method)
			}
			bearer = strings.TrimSpace(bearer)
			if bearer == "" {
				return errors.New("no token provided")
			}
			keyID, secret, err := credstore.ParseBearer(bearer)
			if err != nil {
				return fmt.Errorf("invalid token: %w", err)
			}

			cl := client.New(apiURL, keyID, secret)
			var resp client.LoginResponse
			if err := cl.DoJSON(CtxBackground(), "POST", "/v1/auth/login", nil, struct{}{}, &resp); err != nil {
				if httpErr := asHTTPError(err); httpErr != nil {
					if httpErr.Status == http.StatusForbidden && strings.Contains(httpErr.Body, "not_an_operator_token") {
						return errors.New(
							"this token is not an operator token — bootstrap/admin keys cannot login.\n" +
								"Ask an admin to run `polaris-email operator add` to mint you an operator credential.",
						)
					}
				}
				return fmt.Errorf("login failed: %w", err)
			}

			store, err := credstore.New()
			if err != nil {
				return fmt.Errorf("open credstore: %w", err)
			}
			cred := credstore.Credential{
				APIURL: apiURL, KeyID: keyID, Secret: secret,
				OperatorID: resp.Operator.ID, Email: resp.Operator.Email,
				Name: resp.Operator.Name, Role: resp.Operator.Role,
				StoredAt: time.Now().UTC(),
			}
			if err := store.Save(activeProfile, cred); err != nil {
				return fmt.Errorf("save credstore entry: %w", err)
			}
			fmt.Fprintf(Out, "✓ Logged in as %s <%s> (role: %s)\n", resp.Operator.Name, resp.Operator.Email, resp.Operator.Role)
			fmt.Fprintf(Out, "  Profile:    %s\n", activeProfile)
			fmt.Fprintf(Out, "  API URL:    %s\n", apiURL)
			fmt.Fprintf(Out, "  Operator:   %s\n", resp.Operator.ID)
			return nil
		},
	}
	c.Flags().StringVar(&apiURL, "api-url", "", "API base URL (overrides $POLARIS_API_URL)")
	c.Flags().StringVar(&method, "method", "paste", "input method: paste | stdin")
	c.Flags().StringVar(&token, "token", "", "supply the bearer directly (skips the paste prompt)")
	c.Flags().StringVar(&profile, "profile", "", "name to store the credential under (default: \"default\")")
	return c
}

func newLogoutCmd() *cobra.Command {
	var profile string
	c := &cobra.Command{
		Use:   "logout",
		Short: "Forget the stored bearer for a profile",
		RunE: func(_ *cobra.Command, _ []string) error {
			activeProfile := profile
			if activeProfile == "" {
				activeProfile = "default"
			}
			store, err := credstore.New()
			if err != nil {
				return fmt.Errorf("open credstore: %w", err)
			}
			cred, loadErr := store.Load(activeProfile)
			if loadErr == nil && cred != nil {
				cl := client.New(cred.APIURL, cred.KeyID, cred.Secret)
				_ = cl.DoJSON(CtxBackground(), "POST", "/v1/auth/logout", nil, struct{}{}, nil)
			}
			if err := store.Delete(activeProfile); err != nil {
				if errors.Is(err, credstore.ErrNotFound) {
					fmt.Fprintf(Out, "no stored credential for profile %q\n", activeProfile)
					return nil
				}
				return err
			}
			fmt.Fprintf(Out, "✓ Cleared credential for profile %q\n", activeProfile)
			return nil
		},
	}
	c.Flags().StringVar(&profile, "profile", "", "profile name to clear (default: \"default\")")
	return c
}

func newWhoamiCmd() *cobra.Command {
	var profile string
	var verify bool
	c := &cobra.Command{
		Use:   "whoami",
		Short: "Print the operator identity cached in the keychain for a profile",
		RunE: func(_ *cobra.Command, _ []string) error {
			activeProfile := profile
			if activeProfile == "" {
				activeProfile = G.Profile
			}
			if activeProfile == "" {
				activeProfile = "default"
			}
			store, err := credstore.New()
			if err != nil {
				return fmt.Errorf("open credstore: %w", err)
			}
			cred, err := store.Load(activeProfile)
			if err != nil {
				if errors.Is(err, credstore.ErrNotFound) {
					return fmt.Errorf("no stored credential for profile %q (run `polaris-email login`)", activeProfile)
				}
				return err
			}
			fmt.Fprintf(Out, "Profile:    %s\n", activeProfile)
			fmt.Fprintf(Out, "API URL:    %s\n", cred.APIURL)
			fmt.Fprintf(Out, "Operator:   %s\n", cred.OperatorID)
			fmt.Fprintf(Out, "Name:       %s\n", cred.Name)
			fmt.Fprintf(Out, "Email:      %s\n", cred.Email)
			fmt.Fprintf(Out, "Role:       %s\n", cred.Role)
			fmt.Fprintf(Out, "Key id:     %s\n", cred.KeyID)
			fmt.Fprintf(Out, "Stored at:  %s\n", cred.StoredAt.Format(time.RFC3339))
			if verify {
				cl := client.New(cred.APIURL, cred.KeyID, cred.Secret)
				var resp client.LoginResponse
				if err := cl.DoJSON(CtxBackground(), "POST", "/v1/auth/login", nil, struct{}{}, &resp); err != nil {
					fmt.Fprintf(Errw, "verify: %v\n", err)
					return err
				}
				fmt.Fprintln(Out, "Verify:     ✓ token is valid")
			}
			return nil
		},
	}
	c.Flags().StringVar(&profile, "profile", "", "profile to inspect (default: --profile or \"default\")")
	c.Flags().BoolVarP(&verify, "verify", "v", false, "re-validate the cached bearer against the API")
	return c
}

func newProfileCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "profile",
		Short: "Manage stored credential profiles",
	}
	c.AddCommand(
		&cobra.Command{
			Use:   "list",
			Short: "List profile names with stored credentials",
			RunE: func(_ *cobra.Command, _ []string) error {
				store, err := credstore.New()
				if err != nil {
					return err
				}
				names, err := store.List()
				if err != nil {
					return err
				}
				if len(names) == 0 {
					fmt.Fprintln(Out, "(no stored profiles — run `polaris-email login` first)")
					return nil
				}
				for _, n := range names {
					fmt.Fprintln(Out, n)
				}
				return nil
			},
		},
		&cobra.Command{
			Use:   "delete <profile>",
			Short: "Delete a stored profile (alias for `polaris-email logout --profile <name>`)",
			Args:  cobra.ExactArgs(1),
			RunE: func(_ *cobra.Command, args []string) error {
				store, err := credstore.New()
				if err != nil {
					return err
				}
				if err := store.Delete(args[0]); err != nil {
					return err
				}
				fmt.Fprintf(Out, "✓ Cleared %q\n", args[0])
				return nil
			},
		},
	)
	return c
}

func asHTTPError(err error) *client.HTTPError {
	if err == nil {
		return nil
	}
	if e, ok := err.(*client.HTTPError); ok {
		return e
	}
	return nil
}
