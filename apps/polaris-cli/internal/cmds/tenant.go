package cmds

import (
	"fmt"
	"net/url"
	"time"

	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/output"
)

func newTenantCmd() *cobra.Command {
	c := &cobra.Command{Use: "tenant", Short: "Manage tenants (consumer aggregates)"}
	c.AddCommand(tenantListCmd(), tenantShowCmd(), tenantCreateCmd(), tenantRotatePepperCmd(), tenantDisableCmd())
	return c
}

func tenantListCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List tenants",
		RunE: func(_ *cobra.Command, _ []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			var out []client.Tenant
			if err := cl.DoJSON(CtxBackground(), "GET", "/v1/admin/tenants", nil, nil, &out); err != nil {
				return err
			}
			t := &output.Table{Headers: []string{"NAME", "ENV", "PEPPER_VER", "CREATED"}}
			for _, x := range out {
				t.Rows = append(t.Rows, []string{x.Name, x.Environment, fmt.Sprintf("%d", x.PepperVersion), x.CreatedAt.Format(time.RFC3339)})
			}
			return EmitTable(t, out)
		},
	}
}

func tenantShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show <name>",
		Short: "Show one tenant",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			q := url.Values{"name": []string{args[0]}}
			var out client.Tenant
			if err := cl.DoJSON(CtxBackground(), "GET", "/v1/admin/tenants/lookup", q, nil, &out); err != nil {
				return err
			}
			return Emit(out)
		},
	}
}

func tenantCreateCmd() *cobra.Command {
	var desc, env string
	c := &cobra.Command{
		Use:   "create <name>",
		Short: "Create a tenant (mints a per-tenant pepper)",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			req := client.TenantCreateRequest{Name: args[0], Description: desc, Environment: env}
			var out client.Tenant
			if err := cl.DoJSON(CtxBackground(), "POST", "/v1/admin/tenants", nil, req, &out); err != nil {
				return err
			}
			return Emit(out)
		},
	}
	c.Flags().StringVar(&desc, "description", "", "human-readable description")
	c.Flags().StringVar(&env, "environment", "prod", "environment label")
	return c
}

func tenantRotatePepperCmd() *cobra.Command {
	var confirm string
	c := &cobra.Command{
		Use:   "rotate-pepper <name>",
		Short: "Rotate the recipient hashing pepper (two-person rule on the API)",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			if confirm != args[0] {
				return fmt.Errorf("--confirm-tenant must equal the tenant name")
			}
			path := fmt.Sprintf("/v1/admin/tenants/%s/rotate-pepper", url.PathEscape(args[0]))
			var out client.Tenant
			if err := cl.DoJSON(CtxBackground(), "POST", path, nil, nil, &out); err != nil {
				return err
			}
			return Emit(out)
		},
	}
	c.Flags().StringVar(&confirm, "confirm-tenant", "", "must equal the tenant name")
	return c
}

func tenantDisableCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "disable <name>",
		Short: "Soft-disable a tenant (revokes all principals)",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			path := fmt.Sprintf("/v1/admin/tenants/%s", url.PathEscape(args[0]))
			body := map[string]any{"disabled": true}
			var out client.Tenant
			if err := cl.DoJSON(CtxBackground(), "PATCH", path, nil, body, &out); err != nil {
				return err
			}
			return Emit(out)
		},
	}
}
