package cmds

import (
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/output"
)

// MailboxCredential mirrors the GET /v1/admin/mailboxes/:id/credentials
// row shape post-refactor — one unified table for IMAP, SMTP, REST, MCP,
// and CLI credentials.
type MailboxCredential struct {
	ID               string     `json:"id"`
	MailboxID        string     `json:"mailbox_id"`
	Type             string     `json:"type"`
	Prefix           string     `json:"prefix"`
	ReceiverID       *string    `json:"receiver_id,omitempty"`
	DisplayName      *string    `json:"display_name,omitempty"`
	Status           string     `json:"status"`
	RateLimitPerMin  int        `json:"rate_limit_per_min"`
	CreatedAt        time.Time  `json:"created_at"`
	LastUsedAt       *time.Time `json:"last_used_at,omitempty"`
	DisabledAt       *time.Time `json:"disabled_at,omitempty"`
	RevokedAt        *time.Time `json:"revoked_at,omitempty"`
}

type issueResponse struct {
	ID          string  `json:"id"`
	Type        string  `json:"type"`
	Prefix      string  `json:"prefix"`
	MailboxID   string  `json:"mailbox_id"`
	ReceiverID  *string `json:"receiver_id,omitempty"`
	DisplayName *string `json:"display_name,omitempty"`
	// IMAP/SMTP shape
	Username string `json:"username,omitempty"`
	Password string `json:"password,omitempty"`
	// REST/MCP/CLI shape
	KeyID     string `json:"key_id,omitempty"`
	KeySecret string `json:"key_secret,omitempty"`
	Bearer    string `json:"bearer,omitempty"`
}

func newCredCmd() *cobra.Command {
	c := &cobra.Command{Use: "cred", Short: "Manage mailbox credentials"}
	c.AddCommand(credIssueCmd(), credListCmd(), credRevokeCmd(), credRotateCmd())
	return c
}

func credIssueCmd() *cobra.Command {
	var mailbox, ctype, receiverID, displayName string
	c := &cobra.Command{
		Use:   "issue",
		Short: "Issue a new credential (returns plaintext secret ONCE)",
		Long: "Mints a credential against a mailbox. Type=imap|smtp issues a USER+PASS pair; " +
			"type=rest|mcp|cli issues a bearer token. IMAP credentials require --receiver.",
		RunE: func(_ *cobra.Command, _ []string) error {
			if mailbox == "" {
				return fmt.Errorf("--mailbox required")
			}
			switch ctype {
			case "imap", "smtp", "rest", "mcp", "cli":
				// ok
			default:
				return fmt.Errorf("--type must be one of imap|smtp|rest|mcp|cli (got %q)", ctype)
			}
			if ctype == "imap" && receiverID == "" {
				return fmt.Errorf("--receiver required for --type=imap")
			}
			if ctype != "imap" && receiverID != "" {
				return fmt.Errorf("--receiver only valid with --type=imap")
			}
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			mailboxID, err := resolveMailboxID(cl, mailbox)
			if err != nil {
				return err
			}
			body := map[string]any{"type": ctype}
			if receiverID != "" {
				body["receiver_id"] = receiverID
			}
			if displayName != "" {
				body["display_name"] = displayName
			}
			var resp issueResponse
			path := fmt.Sprintf("/v1/admin/mailboxes/%s/credentials", url.PathEscape(mailboxID))
			if err := cl.DoJSON(CtxBackground(), "POST", path, nil, body, &resp); err != nil {
				return err
			}
			if Format() == output.FormatTable {
				if err := renderIssueTable(&resp); err != nil {
					return err
				}
			} else if err := Emit(resp); err != nil {
				return err
			}
			fmt.Fprintln(Errw, "==> store this secret NOW; it will not be shown again.")
			return nil
		},
	}
	c.Flags().StringVar(&mailbox, "mailbox", "", "mailbox name or id (required)")
	c.Flags().StringVar(&ctype, "type", "smtp", "credential type: imap|smtp|rest|mcp|cli")
	c.Flags().StringVar(&receiverID, "receiver", "", "receiver id (required for --type=imap)")
	c.Flags().StringVar(&displayName, "name", "", "optional display label")
	return c
}

func renderIssueTable(r *issueResponse) error {
	switch r.Type {
	case "imap", "smtp":
		t := &output.Table{
			Headers: []string{"ID", "TYPE", "USERNAME", "PASSWORD"},
			Rows:    [][]string{{r.ID, r.Type, r.Username, r.Password}},
		}
		return t.Render(Out)
	default:
		// rest/mcp/cli
		t := &output.Table{
			Headers: []string{"ID", "TYPE", "BEARER"},
			Rows:    [][]string{{r.ID, r.Type, r.Bearer}},
		}
		return t.Render(Out)
	}
}

func credListCmd() *cobra.Command {
	var mailbox, ctype string
	c := &cobra.Command{
		Use:   "list",
		Short: "List credentials for a mailbox",
		RunE: func(_ *cobra.Command, _ []string) error {
			if mailbox == "" {
				return fmt.Errorf("--mailbox required")
			}
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			mailboxID, err := resolveMailboxID(cl, mailbox)
			if err != nil {
				return err
			}
			path := fmt.Sprintf("/v1/admin/mailboxes/%s/credentials", url.PathEscape(mailboxID))
			var resp struct {
				Data []MailboxCredential `json:"data"`
			}
			if err := cl.DoJSON(CtxBackground(), "GET", path, nil, nil, &resp); err != nil {
				return err
			}
			rows := resp.Data
			if ctype != "" {
				filtered := rows[:0]
				for _, r := range rows {
					if r.Type == ctype {
						filtered = append(filtered, r)
					}
				}
				rows = filtered
			}
			t := &output.Table{
				Headers: []string{"ID", "TYPE", "NAME", "STATUS", "LAST_USED"},
			}
			for _, r := range rows {
				name := "-"
				if r.DisplayName != nil {
					name = *r.DisplayName
				}
				lu := "-"
				if r.LastUsedAt != nil {
					lu = r.LastUsedAt.Format(time.RFC3339)
				}
				status := r.Status
				if r.DisabledAt != nil || r.RevokedAt != nil {
					status = "revoked"
				}
				t.Rows = append(t.Rows, []string{r.ID, r.Type, name, status, lu})
			}
			return EmitTable(t, rows)
		},
	}
	c.Flags().StringVar(&mailbox, "mailbox", "", "mailbox name or id (required)")
	c.Flags().StringVar(&ctype, "type", "", "filter by type: imap|smtp|rest|mcp|cli")
	return c
}

func credRevokeCmd() *cobra.Command {
	var mailbox string
	c := &cobra.Command{
		Use:   "revoke <id>",
		Short: "Revoke a credential",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			if mailbox == "" {
				return fmt.Errorf("--mailbox required")
			}
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			mailboxID, err := resolveMailboxID(cl, mailbox)
			if err != nil {
				return err
			}
			path := fmt.Sprintf(
				"/v1/admin/mailboxes/%s/credentials/%s",
				url.PathEscape(mailboxID),
				url.PathEscape(args[0]),
			)
			if err := cl.DoJSON(CtxBackground(), "DELETE", path, nil, nil, nil); err != nil {
				return err
			}
			fmt.Fprintln(Out, "ok")
			return nil
		},
	}
	c.Flags().StringVar(&mailbox, "mailbox", "", "mailbox name or id (required)")
	return c
}

func credRotateCmd() *cobra.Command {
	var mailbox, mode string
	c := &cobra.Command{
		Use:   "rotate <id>",
		Short: "Rotate a credential (returns new plaintext ONCE)",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			if mailbox == "" {
				return fmt.Errorf("--mailbox required")
			}
			if mode != "planned" && mode != "emergency" {
				return fmt.Errorf("--mode must be planned|emergency (got %q)", mode)
			}
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			mailboxID, err := resolveMailboxID(cl, mailbox)
			if err != nil {
				return err
			}
			path := fmt.Sprintf(
				"/v1/admin/mailboxes/%s/credentials/%s/rotate",
				url.PathEscape(mailboxID),
				url.PathEscape(args[0]),
			)
			var resp issueResponse
			if err := cl.DoJSON(CtxBackground(), "POST", path, nil, map[string]any{"mode": mode}, &resp); err != nil {
				return err
			}
			if Format() == output.FormatTable {
				if err := renderIssueTable(&resp); err != nil {
					return err
				}
			} else if err := Emit(resp); err != nil {
				return err
			}
			fmt.Fprintln(Errw, "==> store the rotated secret NOW; it will not be shown again.")
			return nil
		},
	}
	c.Flags().StringVar(&mailbox, "mailbox", "", "mailbox name or id (required)")
	c.Flags().StringVar(&mode, "mode", "planned", "planned (grace window) or emergency (immediate)")
	return c
}

// resolveMailboxID accepts either a ULID or a mailbox name; for names it
// queries GET /v1/admin/mailboxes?name=… and returns the matching id.
// Pre-production: this is intentionally simple; ULIDs short-circuit
// without an API round-trip.
func resolveMailboxID(cl *client.Client, mailbox string) (string, error) {
	// 26-char Crockford ULIDs go straight through.
	if len(mailbox) == 26 && isUlid(mailbox) {
		return mailbox, nil
	}
	q := url.Values{}
	q.Set("name", mailbox)
	var resp struct {
		Data []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"data"`
	}
	if err := cl.DoJSON(CtxBackground(), "GET", "/v1/admin/mailboxes", q, nil, &resp); err != nil {
		return "", fmt.Errorf("resolve mailbox %q: %w", mailbox, err)
	}
	for _, m := range resp.Data {
		if m.Name == mailbox {
			return m.ID, nil
		}
	}
	return "", fmt.Errorf("mailbox %q not found", mailbox)
}

func isUlid(s string) bool {
	if len(s) != 26 {
		return false
	}
	for _, c := range s {
		switch {
		case c >= '0' && c <= '9':
		case c >= 'A' && c <= 'H':
		case c == 'J', c == 'K', c == 'M', c == 'N':
		case c >= 'P' && c <= 'T':
		case c >= 'V' && c <= 'Z':
		default:
			return false
		}
		_ = strings.IndexByte // keep import alive without growing surface
	}
	return true
}
