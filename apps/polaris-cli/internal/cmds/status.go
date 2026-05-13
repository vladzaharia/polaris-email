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
	c := &cobra.Command{
		Use:   "status",
		Short: "Daemon health + domain status + recent error rate",
		RunE: func(_ *cobra.Command, _ []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			q := url.Values{}
			if domain != "" {
				q.Set("domain", domain)
			}
			var out client.StatusReport
			if err := cl.DoJSON(CtxBackground(), "GET", "/v1/admin/status", q, nil, &out); err != nil {
				return err
			}
			if Format() == output.FormatTable {
				dt := &output.Table{Headers: []string{"DAEMON", "HEALTHY", "LAST_SEEN", "BUILD"}}
				for _, d := range out.Daemons {
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
				return nil
			}
			return Emit(out)
		},
	}
	c.Flags().StringVar(&domain, "domain", "", "filter by domain")
	return c
}
