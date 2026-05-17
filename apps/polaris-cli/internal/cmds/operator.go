// polaris-email operator [...] — manage human + service-account identities
// that gate CLI/TUI/Wish access.
package cmds

import (
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/output"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/wizards"
)

func newOperatorCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "operator",
		Short: "Manage operators (humans + service accounts with CLI/TUI/SSH access)",
		Long: `Operators are the named identities that drive every authenticated
session in polaris-email — CLI, TUI (local), and TUI over Wish/SSH.

Each operator owns one api_key. The api_key plaintext is shown ONCE by
` + "`operator add`" + ` and is meant to be pasted into ` + "`polaris-email login`" + `
(stored encrypted in the OS keychain) or passed via --token for one-shot use.`,
	}
	c.AddCommand(
		operatorListCmd(),
		operatorAddCmd(),
		operatorShowCmd(),
		operatorUpdateCmd(),
		operatorDisableCmd(),
		operatorRemoveCmd(),
		operatorRotateKeyCmd(),
		operatorRotatePubkeyCmd(),
	)
	return c
}

func operatorListCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List operators",
		RunE: func(_ *cobra.Command, _ []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			var resp struct {
				Data []client.Operator `json:"data"`
			}
			if err := cl.DoJSON(CtxBackground(), "GET", "/v1/admin/operators", nil, nil, &resp); err != nil {
				return err
			}
			t := &output.Table{Headers: []string{"ID", "NAME", "EMAIL", "ROLE", "FINGERPRINT", "DISABLED", "LAST_SEEN"}}
			for _, op := range resp.Data {
				fp := op.SSHPubkeyFPSHA256
				if len(fp) > 24 {
					fp = fp[:17] + "…" + fp[len(fp)-4:]
				}
				disabled := "no"
				if op.DisabledAt != nil {
					disabled = "yes"
				}
				lastSeen := "-"
				if op.LastSeenAt != nil {
					lastSeen = op.LastSeenAt.Format(time.RFC3339)
				}
				t.Rows = append(t.Rows, []string{op.ID, op.Name, op.Email, op.Role, fp, disabled, lastSeen})
			}
			return EmitTable(t, resp.Data)
		},
	}
}

func operatorAddCmd() *cobra.Command {
	var (
		fromFile, name, email, role, pubkeyPath, writeProfile string
	)
	c := &cobra.Command{
		Use:   "add",
		Short: "Enroll a new operator (interactive wizard or --from-file)",
		RunE: func(_ *cobra.Command, _ []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			var in *wizards.OperatorAddInput
			switch {
			case fromFile != "":
				in, err = wizards.LoadOperatorAddFile(fromFile)
				if err != nil {
					return err
				}
			case name != "" && email != "" && pubkeyPath != "":
				in = &wizards.OperatorAddInput{
					Name: name, Email: email, Role: role,
					SSHPubkeyPath: pubkeyPath, WriteProfile: writeProfile,
				}
				if err := in.Validate(); err != nil {
					return err
				}
			default:
				seed := &wizards.OperatorAddInput{
					Name: name, Email: email, Role: role,
					SSHPubkeyPath: pubkeyPath, WriteProfile: writeProfile,
				}
				in, err = wizards.PromptOperatorAdd(seed)
				if err != nil {
					return err
				}
			}
			_, err = wizards.RunOperatorAdd(CtxBackground(), cl, in, Out)
			return err
		},
	}
	c.Flags().StringVar(&fromFile, "from-file", "", "non-interactive YAML/JSON input")
	c.Flags().StringVar(&name, "name", "", "operator display name")
	c.Flags().StringVar(&email, "email", "", "operator email")
	c.Flags().StringVar(&role, "role", "", "operator|admin|readonly (default operator)")
	c.Flags().StringVar(&pubkeyPath, "ssh-pubkey-path", "", "path to a .pub file (alternative to interactive paste)")
	c.Flags().StringVar(&writeProfile, "write-profile", "", "(reserved) also stash the new bearer locally under this profile name")
	return c
}

func operatorShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show <id-or-email>",
		Short: "Show one operator",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			lookup := args[0]
			if isLikelyULID(lookup) {
				var resp client.OperatorEnvelope
				path := fmt.Sprintf("/v1/admin/operators/%s", url.PathEscape(lookup))
				if err := cl.DoJSON(CtxBackground(), "GET", path, nil, nil, &resp); err != nil {
					return err
				}
				return Emit(resp.Operator)
			}
			var list struct {
				Data []client.Operator `json:"data"`
			}
			if err := cl.DoJSON(CtxBackground(), "GET", "/v1/admin/operators", nil, nil, &list); err != nil {
				return err
			}
			for _, op := range list.Data {
				if strings.EqualFold(op.Email, lookup) {
					var resp client.OperatorEnvelope
					path := fmt.Sprintf("/v1/admin/operators/%s", url.PathEscape(op.ID))
					if err := cl.DoJSON(CtxBackground(), "GET", path, nil, nil, &resp); err != nil {
						return err
					}
					return Emit(resp.Operator)
				}
			}
			return fmt.Errorf("operator %q not found", lookup)
		},
	}
}

func operatorUpdateCmd() *cobra.Command {
	var name, role string
	c := &cobra.Command{
		Use:   "update <id>",
		Short: "Update operator name or role",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			req := client.OperatorUpdateRequest{}
			if name != "" {
				req.Name = name
			}
			if role != "" {
				req.Role = role
			}
			path := fmt.Sprintf("/v1/admin/operators/%s", url.PathEscape(args[0]))
			return cl.DoJSON(CtxBackground(), "PATCH", path, nil, req, nil)
		},
	}
	c.Flags().StringVar(&name, "name", "", "new display name")
	c.Flags().StringVar(&role, "role", "", "new role (operator|admin|readonly)")
	return c
}

func operatorDisableCmd() *cobra.Command {
	var confirm string
	c := &cobra.Command{
		Use:   "disable <id>",
		Short: "Soft-disable an operator (revokes their api_key, kicks active SSH sessions ≤60s later)",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			if confirm != args[0] {
				return fmt.Errorf("--confirm-id must equal the operator id (%q)", args[0])
			}
			disabled := true
			req := client.OperatorUpdateRequest{Disabled: &disabled}
			path := fmt.Sprintf("/v1/admin/operators/%s", url.PathEscape(args[0]))
			if err := cl.DoJSON(CtxBackground(), "PATCH", path, nil, req, nil); err != nil {
				return err
			}
			fmt.Fprintln(Out, "ok")
			return nil
		},
	}
	c.Flags().StringVar(&confirm, "confirm-id", "", "must equal the operator id (guard against fat-finger)")
	return c
}

func operatorRemoveCmd() *cobra.Command {
	var confirm string
	c := &cobra.Command{
		Use:   "remove <id>",
		Short: "Alias for `operator disable`",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			if confirm != args[0] {
				return fmt.Errorf("--confirm-id must equal the operator id (%q)", args[0])
			}
			path := fmt.Sprintf("/v1/admin/operators/%s", url.PathEscape(args[0]))
			if err := cl.DoJSON(CtxBackground(), "DELETE", path, nil, nil, nil); err != nil {
				return err
			}
			fmt.Fprintln(Out, "ok")
			return nil
		},
	}
	c.Flags().StringVar(&confirm, "confirm-id", "", "must equal the operator id")
	return c
}

func operatorRotateKeyCmd() *cobra.Command {
	var confirm string
	c := &cobra.Command{
		Use:   "rotate-key <id>",
		Short: "Rotate the operator's underlying api_key (returns a new login_token ONCE)",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			if confirm != args[0] {
				return fmt.Errorf("--confirm-id must equal the operator id (%q)", args[0])
			}
			path := fmt.Sprintf("/v1/admin/operators/%s/rotate-key", url.PathEscape(args[0]))
			var out client.OperatorIssueResponse
			if err := cl.DoJSON(CtxBackground(), "POST", path, nil, nil, &out); err != nil {
				return err
			}
			fmt.Fprintf(Out, "✓ Rotated. New api_key_id: %s\n\n", out.APIKeyID)
			fmt.Fprintln(Out, "New login token (paste into `polaris-email login`):")
			fmt.Fprintln(Out)
			fmt.Fprintf(Out, "  %s\n", out.LoginToken)
			fmt.Fprintln(Out)
			fmt.Fprintln(Errw, "↑ Shown ONCE. The previous key has been revoked.")
			return nil
		},
	}
	c.Flags().StringVar(&confirm, "confirm-id", "", "must equal the operator id")
	return c
}

func operatorRotatePubkeyCmd() *cobra.Command {
	var pubkeyPath, confirm string
	c := &cobra.Command{
		Use:   "rotate-pubkey <id>",
		Short: "Replace the operator's SSH pubkey (the api_key is not affected)",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			if confirm != args[0] {
				return fmt.Errorf("--confirm-id must equal the operator id (%q)", args[0])
			}
			if pubkeyPath == "" {
				return fmt.Errorf("--ssh-pubkey-path is required")
			}
			seed := &wizards.OperatorAddInput{SSHPubkeyPath: pubkeyPath, Name: "_rotate_", Email: "_rotate_@example.com"}
			if err := seed.Validate(); err != nil {
				return err
			}
			req := client.OperatorRotatePubkeyRequest{
				SSHPubkey:         seed.SSHPubkey,
				SSHPubkeyFPSHA256: seed.SSHPubkeyFPSHA256,
			}
			path := fmt.Sprintf("/v1/admin/operators/%s/rotate-pubkey", url.PathEscape(args[0]))
			if err := cl.DoJSON(CtxBackground(), "POST", path, nil, req, nil); err != nil {
				return err
			}
			fmt.Fprintf(Out, "✓ Rotated pubkey. New fingerprint: %s\n", seed.SSHPubkeyFPSHA256)
			return nil
		},
	}
	c.Flags().StringVar(&pubkeyPath, "ssh-pubkey-path", "", "path to the new .pub file")
	c.Flags().StringVar(&confirm, "confirm-id", "", "must equal the operator id")
	return c
}

func isLikelyULID(s string) bool {
	if len(s) != 26 {
		return false
	}
	for _, r := range s {
		if !((r >= '0' && r <= '9') || (r >= 'A' && r <= 'Z')) {
			return false
		}
	}
	return true
}
