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

// CredIssueInput drives `polaris-email cred issue`.
type CredIssueInput struct {
	TenantName    string   `json:"tenant_name" yaml:"tenant_name"`
	Type          string   `json:"type" yaml:"type"` // smtp|api
	Senders       []string `json:"senders" yaml:"senders"`
	CreateSenders bool     `json:"create_senders,omitempty" yaml:"create_senders,omitempty"`
}

// Validate enforces the JSON-schema rules.
func (in *CredIssueInput) Validate() error {
	if strings.TrimSpace(in.TenantName) == "" {
		return errors.New("tenant_name is required")
	}
	if in.Type != "smtp" && in.Type != "api" {
		return fmt.Errorf("type %q invalid (want smtp|api)", in.Type)
	}
	if len(in.Senders) == 0 {
		return errors.New("at least one sender is required")
	}
	for _, s := range in.Senders {
		if !strings.Contains(s, "@") || strings.HasPrefix(s, "@") || strings.HasSuffix(s, "@") {
			return fmt.Errorf("sender %q must be local@domain", s)
		}
	}
	return nil
}

// LoadCredIssueFile parses --from-file.
func LoadCredIssueFile(path string) (*CredIssueInput, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	in := &CredIssueInput{}
	if strings.HasSuffix(path, ".json") {
		if err := json.Unmarshal(data, in); err != nil {
			return nil, err
		}
	} else {
		if err := yaml.Unmarshal(data, in); err != nil {
			return nil, err
		}
	}
	return in, in.Validate()
}

// PromptCredIssue runs the interactive wizard.
func PromptCredIssue(initial *CredIssueInput) (*CredIssueInput, error) {
	in := &CredIssueInput{Type: "smtp"}
	if initial != nil {
		*in = *initial
	}
	sendersStr := strings.Join(in.Senders, ",")

	form := huh.NewForm(
		huh.NewGroup(
			huh.NewInput().Title("Tenant name").Value(&in.TenantName),
			huh.NewSelect[string]().Title("Credential type").
				Options(
					huh.NewOption("SMTP (bcrypt, for submission daemon)", "smtp"),
					huh.NewOption("API key (HMAC, for /v1/send)", "api"),
				).Value(&in.Type),
			huh.NewInput().Title("Senders (comma-separated local@domain)").Value(&sendersStr),
			huh.NewConfirm().Title("Create missing email_senders rows?").Value(&in.CreateSenders),
		),
	)
	if err := form.Run(); err != nil {
		return nil, err
	}
	in.Senders = nil
	for _, s := range strings.Split(sendersStr, ",") {
		s = strings.TrimSpace(s)
		if s != "" {
			in.Senders = append(in.Senders, s)
		}
	}
	return in, in.Validate()
}

// RunCredIssue performs the API call. The plaintext secret in the response
// must be persisted by the caller; we never write it to disk ourselves.
func RunCredIssue(ctx context.Context, c *client.Client, in *CredIssueInput, w io.Writer) (*client.CredentialIssueResponse, error) {
	req := client.CredentialIssueRequest{
		TenantName:    in.TenantName,
		Type:          in.Type,
		Senders:       in.Senders,
		CreateSenders: in.CreateSenders,
	}
	var out client.CredentialIssueResponse
	if err := c.DoJSON(ctx, "POST", "/v1/admin/credentials", nil, req, &out); err != nil {
		return nil, err
	}
	if c.DryRun {
		fmt.Fprintln(w, "(dry-run; no credential was issued)")
		return nil, nil
	}
	return &out, nil
}
