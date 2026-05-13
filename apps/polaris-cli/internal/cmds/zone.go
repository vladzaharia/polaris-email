package cmds

import (
	"fmt"
	"net/url"
	"time"

	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/output"
)

func newZoneCmd() *cobra.Command {
	c := &cobra.Command{Use: "zone", Short: "Manage Cloudflare zone aggregates"}
	c.AddCommand(zoneListCmd(), zoneShowCmd(), zoneRotateDKIMCmd())
	return c
}

func zoneListCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List zones",
		RunE: func(_ *cobra.Command, _ []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			var out []client.Zone
			if err := cl.DoJSON(CtxBackground(), "GET", "/v1/admin/zones", nil, nil, &out); err != nil {
				return err
			}
			t := &output.Table{Headers: []string{"NAME", "CF_ZONE_ID", "CREATED"}}
			for _, z := range out {
				t.Rows = append(t.Rows, []string{z.Name, z.CFZoneID, z.CreatedAt.Format(time.RFC3339)})
			}
			return EmitTable(t, out)
		},
	}
}

func zoneShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show <name>",
		Short: "Show one zone",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			q := url.Values{"name": []string{args[0]}}
			var out client.Zone
			if err := cl.DoJSON(CtxBackground(), "GET", "/v1/admin/zones/lookup", q, nil, &out); err != nil {
				return err
			}
			return Emit(out)
		},
	}
}

func zoneRotateDKIMCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "rotate-dkim <name>",
		Short: "Zone-wide DKIM rotation across all child domains",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			path := fmt.Sprintf("/v1/admin/zones/%s/rotate-dkim", url.PathEscape(args[0]))
			var out map[string]any
			if err := cl.DoJSON(CtxBackground(), "POST", path, nil, nil, &out); err != nil {
				return err
			}
			return Emit(out)
		},
	}
}
