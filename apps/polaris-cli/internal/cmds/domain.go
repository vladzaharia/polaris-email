package cmds

import (
	"fmt"
	"net/url"
	"time"

	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/output"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/wizards"
)

func newDomainCmd() *cobra.Command {
	c := &cobra.Command{Use: "domain", Short: "Manage email domains"}
	c.AddCommand(
		domainListCmd(),
		domainShowCmd(),
		domainOnboardCmd(),
		domainVerifyCmd(),
		domainDisableCmd(),
		domainDeleteCmd(),
		domainRotateDKIMCmd(),
		domainBulkOnboardCmd(),
	)
	return c
}

func domainListCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List managed domains",
		RunE: func(_ *cobra.Command, _ []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			var out []client.Domain
			if err := cl.DoJSON(CtxBackground(), "GET", "/v1/admin/domains", nil, nil, &out); err != nil {
				return err
			}
			t := &output.Table{Headers: []string{"NAME", "STATUS", "IN", "OUT", "WILDCARD", "CREATED"}}
			for _, d := range out {
				t.Rows = append(t.Rows, []string{d.Name, d.Status, boolStr(d.InboundEnabled), boolStr(d.OutboundEnabled), boolStr(d.WildcardSubdomains), d.CreatedAt.Format(time.RFC3339)})
			}
			return EmitTable(t, out)
		},
	}
}

func domainShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show <name>",
		Short: "Show one domain in detail",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			q := url.Values{"name": []string{args[0]}}
			var out client.Domain
			if err := cl.DoJSON(CtxBackground(), "GET", "/v1/admin/domains/lookup", q, nil, &out); err != nil {
				return err
			}
			return Emit(out)
		},
	}
}

func domainOnboardCmd() *cobra.Command {
	var fromFile string
	var inbound, outbound, override bool
	var dkim string
	wildcard := true

	c := &cobra.Command{
		Use:   "onboard [name]",
		Short: "Wizard-driven domain onboarding (handles base + sub via zone discovery)",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			var in *wizards.DomainOnboardInput
			if fromFile != "" {
				in, err = wizards.LoadDomainOnboardFile(fromFile)
				if err != nil {
					return err
				}
			} else {
				seed := &wizards.DomainOnboardInput{
					InboundEnabled:     inbound,
					OutboundEnabled:    outbound,
					Override:           override,
					DKIMAlgo:           dkim,
					WildcardSubdomains: &wildcard,
				}
				if len(args) == 1 {
					seed.Name = args[0]
				}
				if cl.DryRun || (seed.Name != "" && (inbound || outbound)) {
					// Non-interactive path when caller has already supplied enough.
					if err := seed.Validate(); err != nil {
						return err
					}
					in = seed
				} else {
					in, err = wizards.PromptDomainOnboard(seed)
					if err != nil {
						return err
					}
				}
			}
			d, err := wizards.RunDomainOnboard(CtxBackground(), cl, in, Out)
			if err != nil {
				return err
			}
			if d != nil {
				return Emit(d)
			}
			return nil
		},
	}
	c.Flags().StringVar(&fromFile, "from-file", "", "non-interactive YAML/JSON input (validated against schema)")
	c.Flags().BoolVar(&inbound, "inbound", false, "enable inbound (Email Routing)")
	c.Flags().BoolVar(&outbound, "outbound", false, "enable outbound (Email Service)")
	c.Flags().BoolVar(&wildcard, "wildcard-subdomains", true, "implicitly cover all subdomains under one DKIM key")
	c.Flags().BoolVar(&override, "override", false, "explicitly override an implicit-parent registration")
	c.Flags().StringVar(&dkim, "dkim-algo", "ed25519", "DKIM algorithm: ed25519|rsa2048")
	return c
}

func domainVerifyCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "verify <name>",
		Short: "Re-check DNS + Cloudflare state for a domain",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			path := fmt.Sprintf("/v1/admin/domains/%s/verify", url.PathEscape(args[0]))
			var out client.Domain
			if err := cl.DoJSON(CtxBackground(), "POST", path, nil, nil, &out); err != nil {
				return err
			}
			return Emit(out)
		},
	}
}

func domainDisableCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "disable <name>",
		Short: "Soft-disable a domain (drains routes, suspends sends)",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			path := fmt.Sprintf("/v1/admin/domains/%s", url.PathEscape(args[0]))
			body := map[string]any{"status": "disabled"}
			var out client.Domain
			if err := cl.DoJSON(CtxBackground(), "PATCH", path, nil, body, &out); err != nil {
				return err
			}
			return Emit(out)
		},
	}
}

func domainDeleteCmd() *cobra.Command {
	var confirm string
	c := &cobra.Command{
		Use:   "delete <name>",
		Short: "Begin domain decommission state machine (two-person rule applies on the API)",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			if confirm != args[0] {
				return fmt.Errorf("--confirm-domain must equal the domain name")
			}
			path := fmt.Sprintf("/v1/admin/domains/%s", url.PathEscape(args[0]))
			var out client.Domain
			if err := cl.DoJSON(CtxBackground(), "DELETE", path, nil, nil, &out); err != nil {
				return err
			}
			return Emit(out)
		},
	}
	c.Flags().StringVar(&confirm, "confirm-domain", "", "must equal the target domain name")
	return c
}

func domainRotateDKIMCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "rotate-dkim <name>",
		Short: "Rotate DKIM keys for a single domain",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			path := fmt.Sprintf("/v1/admin/domains/%s/rotate-dkim", url.PathEscape(args[0]))
			var out client.Domain
			if err := cl.DoJSON(CtxBackground(), "POST", path, nil, nil, &out); err != nil {
				return err
			}
			return Emit(out)
		},
	}
}

func domainBulkOnboardCmd() *cobra.Command {
	var pattern, zone, dkim string
	var inbound, outbound bool
	wildcard := true
	c := &cobra.Command{
		Use:   "bulk-onboard",
		Short: "Provision many subdomain rows under one zone (PaaS-style)",
		RunE: func(_ *cobra.Command, _ []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			if pattern == "" || zone == "" {
				return fmt.Errorf("--pattern and --zone are required")
			}
			req := client.DomainBulkOnboardRequest{
				Pattern:            pattern,
				ZoneName:           zone,
				InboundEnabled:     inbound,
				OutboundEnabled:    outbound,
				WildcardSubdomains: wildcard,
			}
			fmt.Fprintf(Errw, "bulk-onboard: provisioning under zone %s pattern %s ...\n", zone, pattern)
			var out []client.Domain
			if err := cl.DoJSON(CtxBackground(), "POST", "/v1/admin/domains/bulk-onboard", nil, req, &out); err != nil {
				return err
			}
			// The endpoint is synchronous and returns the full list on
			// completion. Stream a per-row progress line so an operator
			// running this on 100+ domains can see what landed; the table
			// summary follows.
			total := len(out)
			for i, d := range out {
				fmt.Fprintf(Errw, "  [%d/%d] %s -> %s\n", i+1, total, d.Name, d.Status)
			}
			fmt.Fprintf(Errw, "bulk-onboard: %d domain(s) processed\n", total)
			t := &output.Table{Headers: []string{"NAME", "STATUS"}}
			for _, d := range out {
				t.Rows = append(t.Rows, []string{d.Name, d.Status})
			}
			_ = dkim // reserved for future per-row override
			return EmitTable(t, out)
		},
	}
	c.Flags().StringVar(&pattern, "pattern", "", "subdomain pattern, e.g. 'tenant-{1..N}.app.example.com'")
	c.Flags().StringVar(&zone, "zone", "", "parent zone name (required)")
	c.Flags().BoolVar(&inbound, "inbound", false, "enable inbound on each row")
	c.Flags().BoolVar(&outbound, "outbound", true, "enable outbound on each row")
	c.Flags().BoolVar(&wildcard, "wildcard-subdomains", false, "wildcard subdomains within each row")
	c.Flags().StringVar(&dkim, "dkim-algo", "ed25519", "DKIM algorithm")
	return c
}

func boolStr(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}
