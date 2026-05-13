// Package wizards holds huh-driven interactive flows. Every wizard accepts
// either interactive prompting or a non-interactive --from-file payload, and
// can run under --dry-run.
package wizards

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/charmbracelet/huh"
	"gopkg.in/yaml.v3"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
)

// DomainOnboardInput is the validated input for the domain-onboarding flow.
//
// JSON-schema for --from-file lives at testdata/wizard-schemas/domain.json.
type DomainOnboardInput struct {
	Name               string `json:"name" yaml:"name"`
	InboundEnabled     bool   `json:"inbound_enabled" yaml:"inbound_enabled"`
	OutboundEnabled    bool   `json:"outbound_enabled" yaml:"outbound_enabled"`
	WildcardSubdomains *bool  `json:"wildcard_subdomains,omitempty" yaml:"wildcard_subdomains,omitempty"`
	Override           bool   `json:"override,omitempty" yaml:"override,omitempty"`
	DKIMAlgo           string `json:"dkim_algo,omitempty" yaml:"dkim_algo,omitempty"` // ed25519|rsa2048
}

// Validate enforces the JSON-schema-equivalent rules.
func (in *DomainOnboardInput) Validate() error {
	if strings.TrimSpace(in.Name) == "" {
		return errors.New("domain.name is required")
	}
	if !in.InboundEnabled && !in.OutboundEnabled {
		return errors.New("at least one of inbound_enabled/outbound_enabled must be true")
	}
	switch in.DKIMAlgo {
	case "", "ed25519", "rsa2048":
	default:
		return fmt.Errorf("dkim_algo %q invalid (want ed25519|rsa2048)", in.DKIMAlgo)
	}
	if !strings.Contains(in.Name, ".") {
		return fmt.Errorf("domain.name %q does not look like a domain", in.Name)
	}
	return nil
}

// LoadDomainOnboardFile parses --from-file payload (TOML or YAML or JSON).
func LoadDomainOnboardFile(path string) (*DomainOnboardInput, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	in := &DomainOnboardInput{}
	if strings.HasSuffix(path, ".json") {
		if err := json.Unmarshal(data, in); err != nil {
			return nil, err
		}
	} else {
		if err := yaml.Unmarshal(data, in); err != nil {
			return nil, err
		}
	}
	if err := in.Validate(); err != nil {
		return nil, err
	}
	return in, nil
}

// PromptDomainOnboard runs the interactive huh wizard.
func PromptDomainOnboard(initial *DomainOnboardInput) (*DomainOnboardInput, error) {
	in := &DomainOnboardInput{}
	if initial != nil {
		*in = *initial
	}
	wildcard := true
	if in.WildcardSubdomains != nil {
		wildcard = *in.WildcardSubdomains
	}
	dkim := in.DKIMAlgo
	if dkim == "" {
		dkim = "ed25519"
	}

	form := huh.NewForm(
		huh.NewGroup(
			huh.NewInput().Title("Domain name").Value(&in.Name).
				Validate(func(s string) error {
					if !strings.Contains(s, ".") {
						return errors.New("must look like a domain")
					}
					return nil
				}),
			huh.NewConfirm().Title("Enable outbound (Email Service)?").Value(&in.OutboundEnabled),
			huh.NewConfirm().Title("Enable inbound (Email Routing)?").Value(&in.InboundEnabled),
			huh.NewConfirm().Title("Cover all subdomains with one DKIM key?").Value(&wildcard),
			huh.NewSelect[string]().Title("DKIM algorithm").
				Options(
					huh.NewOption("ed25519 (preferred)", "ed25519"),
					huh.NewOption("rsa2048 (fallback)", "rsa2048"),
				).Value(&dkim),
			huh.NewConfirm().Title("Override an implicit-parent registration? (--override)").Value(&in.Override),
		),
	)
	if err := form.Run(); err != nil {
		return nil, err
	}
	in.WildcardSubdomains = &wildcard
	in.DKIMAlgo = dkim
	if err := in.Validate(); err != nil {
		return nil, err
	}
	return in, nil
}

// RunDomainOnboard performs the API calls (or prints them under --dry-run).
//
// The control plane does the actual zone discovery + DNS publish. The CLI only
// posts the validated input.
func RunDomainOnboard(ctx context.Context, c *client.Client, in *DomainOnboardInput, w io.Writer) (*client.Domain, error) {
	wildcard := true
	if in.WildcardSubdomains != nil {
		wildcard = *in.WildcardSubdomains
	}
	req := client.DomainCreateRequest{
		Name:               in.Name,
		InboundEnabled:     in.InboundEnabled,
		OutboundEnabled:    in.OutboundEnabled,
		WildcardSubdomains: wildcard,
		Override:           in.Override,
		DKIMAlgo:           in.DKIMAlgo,
	}
	var out client.Domain
	if err := c.DoJSON(ctx, "POST", "/v1/admin/domains", nil, req, &out); err != nil {
		return nil, err
	}
	if c.DryRun {
		fmt.Fprintln(w, "(dry-run; no domain was created)")
		return nil, nil
	}
	// Trigger verify pass.
	if err := c.DoJSON(ctx, "POST", fmt.Sprintf("/v1/admin/domains/%s/verify", out.ID), nil, nil, &out); err != nil {
		return &out, err
	}
	fmt.Fprintf(w, "next steps:\n  polaris-email tenant create <name>\n  polaris-email cred issue --tenant <name> --senders 'noreply@%s'\n  polaris-email route add --domain %s --pattern 'support@*' --action webhook --url ...\n", out.Name, out.Name)
	return &out, nil
}
