package cmds

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/output"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/tui"
)

func newLogsCmd() *cobra.Command {
	c := &cobra.Command{Use: "logs", Short: "Inspect activity logs"}
	c.AddCommand(
		logsSubCmd("send", "Recent outbound (messages table)"),
		logsSubCmd("in", "Recent inbound"),
		logsSubCmd("webhooks", "Webhook delivery state with retry status"),
		logsSubCmd("failures", "Failures across all domains"),
	)
	return c
}

func logsSubCmd(name, short string) *cobra.Command {
	var domain, since string
	var follow bool
	c := &cobra.Command{
		Use:   name,
		Short: short,
		RunE: func(_ *cobra.Command, _ []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			if follow {
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				stream, closer, err := tui.SSEStream(ctx, cl, name, domain)
				if err != nil {
					return err
				}
				defer closer()
				title := fmt.Sprintf("logs %s", name)
				if domain != "" {
					title += " " + domain
				}
				m := tui.New(title, stream)
				p := tea.NewProgram(m, tea.WithAltScreen())
				_, err = p.Run()
				return err
			}
			q := url.Values{"type": []string{name}}
			if domain != "" {
				q.Set("domain", domain)
			}
			if since != "" {
				q.Set("since", since)
			}
			var out []client.LogEntry
			if err := cl.DoJSON(CtxBackground(), "GET", "/v1/admin/logs", q, nil, &out); err != nil {
				return err
			}
			if Format() == output.FormatTable {
				t := &output.Table{Headers: []string{"TIME", "TYPE", "DOMAIN", "STATUS", "SUMMARY"}}
				for _, e := range out {
					t.Rows = append(t.Rows, []string{e.Timestamp.Format(time.RFC3339), e.Type, e.Domain, e.Status, summary(e)})
				}
				return t.Render(Out)
			}
			return Emit(out)
		},
	}
	c.Flags().StringVar(&domain, "domain", "", "filter by domain")
	c.Flags().StringVar(&since, "since", "", "duration like 1h, 24h, 7d")
	c.Flags().BoolVar(&follow, "follow", false, "open Bubble Tea TUI and stream live")
	return c
}

func summary(e client.LogEntry) string {
	if e.Subject != "" {
		return strings.ReplaceAll(e.Subject, "\n", " ")
	}
	if e.Message != "" {
		return strings.ReplaceAll(e.Message, "\n", " ")
	}
	if len(e.Fields) > 0 {
		raw, _ := json.Marshal(e.Fields)
		return string(raw)
	}
	return ""
}
