package cmds

import (
	"fmt"
	"net/url"
	"time"

	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/output"
)

func newCostCmd() *cobra.Command {
	var month string
	c := &cobra.Command{
		Use:   "cost",
		Short: "Pull current-month bill via the Cloudflare billing API",
		RunE: func(_ *cobra.Command, _ []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			if month == "" {
				month = time.Now().UTC().Format("2006-01")
			}
			q := url.Values{"month": []string{month}}
			var out client.CostReport
			if err := cl.DoJSON(CtxBackground(), "GET", "/v1/admin/cost", q, nil, &out); err != nil {
				return err
			}
			if Format() == output.FormatTable {
				t := &output.Table{Headers: []string{"SERVICE", "UNIT", "COUNT", "USD"}}
				for _, l := range out.Lines {
					t.Rows = append(t.Rows, []string{l.Service, l.UnitName, fmt.Sprintf("%.2f", l.UnitCount), fmt.Sprintf("%.4f", l.Cost)})
				}
				if err := t.Render(Out); err != nil {
					return err
				}
				fmt.Fprintf(Out, "\nTOTAL %s: $%.2f\n", out.Month, out.Total)
				return nil
			}
			return Emit(out)
		},
	}
	c.Flags().StringVar(&month, "month", "", "month YYYY-MM (default current UTC month)")
	return c
}
