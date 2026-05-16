package cmds

import (
	"fmt"
	"net/url"
	"os"

	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/output"
)

func newRouteCmd() *cobra.Command {
	c := &cobra.Command{Use: "route", Short: "Manage inbound routing rules"}
	c.AddCommand(routeListCmd(), routeAddCmd(), routeUpdateCmd(), routeDisableCmd(), routeEnableCmd(), routeApplyCmd())
	return c
}

func routeListCmd() *cobra.Command {
	var domain string
	c := &cobra.Command{
		Use:   "list",
		Short: "List routes",
		RunE: func(_ *cobra.Command, _ []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			q := url.Values{}
			if domain != "" {
				q.Set("domain", domain)
			}
			var out []client.Route
			if err := cl.DoJSON(CtxBackground(), "GET", "/v1/admin/routing-rules", q, nil, &out); err != nil {
				return err
			}
			t := &output.Table{Headers: []string{"ID", "DOMAIN", "PATTERN", "ACTION", "TARGET", "ENABLED"}}
			for _, r := range out {
				target := r.URL
				if target == "" {
					target = r.ForwardTo
				}
				t.Rows = append(t.Rows, []string{r.ID, r.DomainName, r.Pattern, r.Action, target, boolStr(r.Enabled)})
			}
			return EmitTable(t, out)
		},
	}
	c.Flags().StringVar(&domain, "domain", "", "filter by domain")
	return c
}

func routeAddCmd() *cobra.Command {
	var domain, pattern, action, urlFlag, fwd, mailbox, tenantDeprecated string
	c := &cobra.Command{
		Use:   "add",
		Short: "Add a route",
		RunE: func(_ *cobra.Command, _ []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			if domain == "" || pattern == "" || action == "" {
				return fmt.Errorf("--domain, --pattern, and --action are required")
			}
			name := mailbox
			if name == "" && tenantDeprecated != "" {
				fmt.Fprintln(Errw, "warning: --tenant is deprecated; use --mailbox")
				name = tenantDeprecated
			}
			req := client.RouteCreateRequest{DomainName: domain, Pattern: pattern, Action: action, URL: urlFlag, ForwardTo: fwd, TenantName: name}
			var out client.Route
			if err := cl.DoJSON(CtxBackground(), "POST", "/v1/admin/routing-rules", nil, req, &out); err != nil {
				return err
			}
			return Emit(out)
		},
	}
	c.Flags().StringVar(&domain, "domain", "", "domain name (required)")
	c.Flags().StringVar(&pattern, "pattern", "", "address pattern, e.g. 'support@*' (required)")
	c.Flags().StringVar(&action, "action", "", "webhook|forward|drop|alias (required)")
	c.Flags().StringVar(&urlFlag, "url", "", "webhook URL (when --action=webhook)")
	c.Flags().StringVar(&fwd, "forward-to", "", "forward target (when --action=forward)")
	c.Flags().StringVar(&mailbox, "mailbox", "", "owning mailbox (optional)")
	c.Flags().StringVar(&tenantDeprecated, "tenant", "", "DEPRECATED alias for --mailbox")
	return c
}

func routeUpdateCmd() *cobra.Command {
	var pattern, action, urlFlag, fwd string
	c := &cobra.Command{
		Use:   "update <id>",
		Short: "Update a route",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			body := map[string]any{}
			if pattern != "" {
				body["pattern"] = pattern
			}
			if action != "" {
				body["action"] = action
			}
			if urlFlag != "" {
				body["url"] = urlFlag
			}
			if fwd != "" {
				body["forward_to"] = fwd
			}
			path := fmt.Sprintf("/v1/admin/routing-rules/%s", url.PathEscape(args[0]))
			var out client.Route
			if err := cl.DoJSON(CtxBackground(), "PATCH", path, nil, body, &out); err != nil {
				return err
			}
			return Emit(out)
		},
	}
	c.Flags().StringVar(&pattern, "pattern", "", "new address pattern (e.g. 'support@*')")
	c.Flags().StringVar(&action, "action", "", "new action: webhook|forward|drop|alias")
	c.Flags().StringVar(&urlFlag, "url", "", "new webhook URL (when action=webhook)")
	c.Flags().StringVar(&fwd, "forward-to", "", "new forward target (when action=forward)")
	return c
}

func routeDisableCmd() *cobra.Command {
	return &cobra.Command{
		Use: "disable <id>", Short: "Disable a route", Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error { return setRouteEnabled(args[0], false) },
	}
}
func routeEnableCmd() *cobra.Command {
	return &cobra.Command{
		Use: "enable <id>", Short: "Enable a route", Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error { return setRouteEnabled(args[0], true) },
	}
}

func setRouteEnabled(id string, enabled bool) error {
	cl, err := MakeClient()
	if err != nil {
		return err
	}
	path := fmt.Sprintf("/v1/admin/routing-rules/%s", url.PathEscape(id))
	body := map[string]any{"enabled": enabled}
	var out client.Route
	if err := cl.DoJSON(CtxBackground(), "PATCH", path, nil, body, &out); err != nil {
		return err
	}
	return Emit(out)
}

func routeApplyCmd() *cobra.Command {
	var file string
	c := &cobra.Command{
		Use:   "apply",
		Short: "Declarative reconcile of routes from a YAML file",
		RunE: func(_ *cobra.Command, _ []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			if file == "" {
				return fmt.Errorf("-f is required")
			}
			data, err := os.ReadFile(file)
			if err != nil {
				return err
			}
			var spec client.RoutesApply
			if err := yaml.Unmarshal(data, &spec); err != nil {
				return err
			}
			var out map[string]any
			if err := cl.DoJSON(CtxBackground(), "POST", "/v1/admin/routing-rules/apply", nil, spec, &out); err != nil {
				return err
			}
			return Emit(out)
		},
	}
	c.Flags().StringVarP(&file, "file", "f", "", "routes.yaml (required)")
	return c
}
