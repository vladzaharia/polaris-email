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

func newCredCmd() *cobra.Command {
	c := &cobra.Command{Use: "cred", Short: "Manage outbound credentials"}
	c.AddCommand(credIssueCmd(), credListCmd(), credRevokeCmd(), credRotateCmd())
	return c
}

func credIssueCmd() *cobra.Command {
	var fromFile, mailbox, tenantDeprecated, ctype, sendersFlag string
	var createSenders bool
	c := &cobra.Command{
		Use:   "issue",
		Short: "Issue a new credential (returns plaintext secret ONCE)",
		RunE: func(_ *cobra.Command, _ []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			// Accept the deprecated --tenant alias for one release with a
			// warning to keep CI pipelines that still pass --tenant working.
			name := mailbox
			if name == "" && tenantDeprecated != "" {
				fmt.Fprintln(Errw, "warning: --tenant is deprecated; use --mailbox (the schema is mailbox-centric)")
				name = tenantDeprecated
			}
			var in *wizards.CredIssueInput
			if fromFile != "" {
				in, err = wizards.LoadCredIssueFile(fromFile)
				if err != nil {
					return err
				}
			} else {
				seed := &wizards.CredIssueInput{
					TenantName:    name,
					Type:          ctype,
					CreateSenders: createSenders,
				}
				if sendersFlag != "" {
					for _, s := range strings.Split(sendersFlag, ",") {
						s = strings.TrimSpace(s)
						if s != "" {
							seed.Senders = append(seed.Senders, s)
						}
					}
				}
				if cl.DryRun || (seed.TenantName != "" && seed.Type != "" && len(seed.Senders) > 0) {
					if err := seed.Validate(); err != nil {
						return err
					}
					in = seed
				} else {
					in, err = wizards.PromptCredIssue(seed)
					if err != nil {
						return err
					}
				}
			}
			r, err := wizards.RunCredIssue(CtxBackground(), cl, in, Out)
			if err != nil {
				return err
			}
			if r != nil {
				// Respect the user's --output choice (table|json|yaml). The
				// secret is a single row so the table form prints headers
				// + one row; pipe-friendly callers should use -o json.
				if Format() == output.FormatTable {
					t := &output.Table{
						Headers: []string{"ID", "MAILBOX", "TYPE", "USERNAME", "SENDERS"},
						Rows: [][]string{{
							r.Credential.ID,
							r.Credential.TenantName,
							r.Credential.Type,
							r.Credential.Username,
							strings.Join(r.Credential.Senders, ","),
						}},
					}
					if err := t.Render(Out); err != nil {
						return err
					}
					fmt.Fprintf(Out, "\nsecret=%s\n", r.Secret)
				} else if err := Emit(r); err != nil {
					return err
				}
				fmt.Fprintln(Errw, "==> store this secret NOW; it will not be shown again.")
			}
			return nil
		},
	}
	c.Flags().StringVar(&fromFile, "from-file", "", "non-interactive YAML/JSON input")
	c.Flags().StringVar(&mailbox, "mailbox", "", "mailbox name or id (the schema is mailbox-centric; see docs/operator.md)")
	c.Flags().StringVar(&tenantDeprecated, "tenant", "", "DEPRECATED alias for --mailbox; prints a warning and will be removed")
	c.Flags().StringVar(&ctype, "type", "smtp", "credential type: smtp|api")
	c.Flags().StringVar(&sendersFlag, "senders", "", "comma-separated local@domain list")
	c.Flags().BoolVar(&createSenders, "create-senders", false, "auto-create missing email_senders rows")
	return c
}

func credListCmd() *cobra.Command {
	var mailbox, tenantDeprecated, ctype string
	c := &cobra.Command{
		Use:   "list",
		Short: "List credentials",
		RunE: func(_ *cobra.Command, _ []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			name := mailbox
			if name == "" && tenantDeprecated != "" {
				fmt.Fprintln(Errw, "warning: --tenant is deprecated; use --mailbox")
				name = tenantDeprecated
			}
			q := url.Values{}
			if name != "" {
				// API still uses the `tenant` query param under the hood;
				// renaming the flag is a CLI ergonomics change.
				q.Set("tenant", name)
			}
			if ctype != "" {
				q.Set("type", ctype)
			}
			var out []client.Credential
			if err := cl.DoJSON(CtxBackground(), "GET", "/v1/admin/credentials", q, nil, &out); err != nil {
				return err
			}
			t := &output.Table{Headers: []string{"ID", "MAILBOX", "TYPE", "USER", "SENDERS", "LAST_USED"}}
			for _, c := range out {
				lu := "-"
				if c.LastUsedAt != nil {
					lu = c.LastUsedAt.Format(time.RFC3339)
				}
				t.Rows = append(t.Rows, []string{c.ID, c.TenantName, c.Type, c.Username, strings.Join(c.Senders, ","), lu})
			}
			return EmitTable(t, out)
		},
	}
	c.Flags().StringVar(&mailbox, "mailbox", "", "filter by mailbox name or id")
	c.Flags().StringVar(&tenantDeprecated, "tenant", "", "DEPRECATED alias for --mailbox")
	c.Flags().StringVar(&ctype, "type", "", "filter by type: smtp|api")
	return c
}

func credRevokeCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "revoke <id>",
		Short: "Revoke a credential",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			path := fmt.Sprintf("/v1/admin/credentials/%s/revoke", url.PathEscape(args[0]))
			if err := cl.DoJSON(CtxBackground(), "POST", path, nil, nil, nil); err != nil {
				return err
			}
			fmt.Fprintln(Out, "ok")
			return nil
		},
	}
}

func credRotateCmd() *cobra.Command {
	var planned, emergency bool
	c := &cobra.Command{
		Use:   "rotate <id>",
		Short: "Rotate a credential",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			mode := "planned"
			if emergency {
				mode = "emergency"
			} else if planned {
				mode = "planned"
			}
			path := fmt.Sprintf("/v1/admin/credentials/%s/rotate", url.PathEscape(args[0]))
			body := map[string]any{"mode": mode}
			var out client.CredentialIssueResponse
			if err := cl.DoJSON(CtxBackground(), "POST", path, nil, body, &out); err != nil {
				return err
			}
			fmt.Fprintln(Errw, "==> store the rotated secret NOW; it will not be shown again.")
			return Emit(out)
		},
	}
	c.Flags().BoolVar(&planned, "planned", false, "planned rotation (overlap window)")
	c.Flags().BoolVar(&emergency, "emergency", false, "emergency rotation (revoke immediately)")
	return c
}
