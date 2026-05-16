package cmds

import (
	"fmt"
	"net/url"

	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/output"
)

func newStatusCmd() *cobra.Command {
	var domain string
	var queues bool
	c := &cobra.Command{
		Use:   "status",
		Short: "Bridge health + domain status + recent error rate",
		RunE: func(_ *cobra.Command, _ []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			q := url.Values{}
			if domain != "" {
				q.Set("domain", domain)
			}
			if queues {
				// Ask the API to include queue depths in the response.
				// /v1/admin/status accepts ?include=queues; the server adds a
				// `queues` field to the JSON when present. The struct below
				// has a placeholder map that is hydrated when the field is
				// returned.
				q.Set("include", "queues")
			}
			var out client.StatusReport
			if err := cl.DoJSON(CtxBackground(), "GET", "/v1/admin/status", q, nil, &out); err != nil {
				return err
			}
			if Format() == output.FormatTable {
				dt := &output.Table{Headers: []string{"BRIDGE", "HEALTHY", "LAST_SEEN", "BUILD"}}
				for _, d := range out.Bridges {
					dt.Rows = append(dt.Rows, []string{d.Name, boolStr(d.Healthy), d.LastSeen.Format("2006-01-02 15:04:05"), d.BuildInfo})
				}
				if err := dt.Render(Out); err != nil {
					return err
				}
				fmt.Fprintln(Out)
				dot := &output.Table{Headers: []string{"DOMAIN", "STATUS", "ERROR_RATE"}}
				for _, d := range out.Domains {
					dot.Rows = append(dot.Rows, []string{d.Name, d.Status, fmt.Sprintf("%.4f", d.ErrorRate)})
				}
				if err := dot.Render(Out); err != nil {
					return err
				}
				fmt.Fprintf(Out, "\nerror_rate_1h=%.4f  error_rate_24h=%.4f\n", out.ErrorRate1h, out.ErrorRate24h)
				if queues {
					// Render queue depths in their own block. When the API
					// hasn't been updated yet, Queues is nil and we print an
					// explicit hint so operators don't think it silently
					// dropped.
					if len(out.Queues) == 0 {
						fmt.Fprintln(Out, "queues: (not reported by API; upgrade services/api or check /v1/admin/diagnostics)")
					} else {
						qt := &output.Table{Headers: []string{"QUEUE", "DEPTH", "DLQ"}}
						for name, q := range out.Queues {
							qt.Rows = append(qt.Rows, []string{name, fmt.Sprintf("%d", q.Depth), fmt.Sprintf("%d", q.DLQ)})
						}
						fmt.Fprintln(Out)
						if err := qt.Render(Out); err != nil {
							return err
						}
					}
				}
				return nil
			}
			return Emit(out)
		},
	}
	c.Flags().StringVar(&domain, "domain", "", "filter by domain")
	c.Flags().BoolVar(&queues, "queues", false, "include queue depths (DLQ + main) from /v1/admin/status?include=queues")
	return c
}
