package cmds

import (
	"fmt"
	"net/url"
	"time"

	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/output"
)

func newWebhookCmd() *cobra.Command {
	c := &cobra.Command{Use: "webhook", Short: "Webhook administration"}
	dlq := &cobra.Command{Use: "dlq", Short: "Webhook dead-letter queue"}
	dlq.AddCommand(dlqListCmd(), dlqInspectCmd(), dlqReplayCmd(), dlqDropCmd())
	c.AddCommand(dlq)
	return c
}

func dlqListCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List webhook DLQ entries",
		RunE: func(_ *cobra.Command, _ []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			var out []client.WebhookDLQEntry
			if err := cl.DoJSON(CtxBackground(), "GET", "/v1/admin/webhook-dlq", nil, nil, &out); err != nil {
				return err
			}
			t := &output.Table{Headers: []string{"ID", "URL", "ATTEMPTS", "LAST_CODE", "FIRST_FAILED"}}
			for _, e := range out {
				t.Rows = append(t.Rows, []string{e.ID, e.URL, fmt.Sprintf("%d", e.AttemptCount), fmt.Sprintf("%d", e.LastResponse), e.FirstFailedAt.Format(time.RFC3339)})
			}
			return EmitTable(t, out)
		},
	}
}

func dlqInspectCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "inspect <id>",
		Short: "Inspect a single DLQ entry",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			path := fmt.Sprintf("/v1/admin/webhook-dlq/%s", url.PathEscape(args[0]))
			var out client.WebhookDLQEntry
			if err := cl.DoJSON(CtxBackground(), "GET", path, nil, nil, &out); err != nil {
				return err
			}
			return Emit(out)
		},
	}
}

func dlqReplayCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "replay <id>",
		Short: "Re-enqueue a DLQ entry for delivery",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			path := fmt.Sprintf("/v1/admin/webhook-dlq/%s/replay", url.PathEscape(args[0]))
			var out map[string]any
			if err := cl.DoJSON(CtxBackground(), "POST", path, nil, nil, &out); err != nil {
				return err
			}
			return Emit(out)
		},
	}
}

func dlqDropCmd() *cobra.Command {
	var confirm string
	c := &cobra.Command{
		Use:   "drop <id>",
		Short: "Permanently drop a DLQ entry",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			if confirm != args[0] {
				return fmt.Errorf("--confirm must equal the DLQ entry id")
			}
			req := client.WebhookDLQDropRequest{Confirm: confirm}
			path := fmt.Sprintf("/v1/admin/webhook-dlq/%s/drop", url.PathEscape(args[0]))
			var out map[string]any
			if err := cl.DoJSON(CtxBackground(), "POST", path, nil, req, &out); err != nil {
				return err
			}
			return Emit(out)
		},
	}
	c.Flags().StringVar(&confirm, "confirm", "", "must equal the DLQ entry id")
	return c
}
