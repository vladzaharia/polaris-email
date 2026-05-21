// Wizard for `polaris-mail operator add`.
package wizards

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/mail"
	"os"
	"strings"

	"github.com/charmbracelet/huh"
	"golang.org/x/crypto/ssh"
	"gopkg.in/yaml.v3"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
)

type OperatorAddInput struct {
	Name              string   `json:"name" yaml:"name"`
	Email             string   `json:"email" yaml:"email"`
	Role              string   `json:"role,omitempty" yaml:"role,omitempty"`
	Scopes            []string `json:"scopes,omitempty" yaml:"scopes,omitempty"`
	RateLimitPerMin   int      `json:"rate_limit_per_min,omitempty" yaml:"rate_limit_per_min,omitempty"`
	SSHPubkey         string   `json:"ssh_pubkey,omitempty" yaml:"ssh_pubkey,omitempty"`
	SSHPubkeyPath     string   `json:"ssh_pubkey_path,omitempty" yaml:"ssh_pubkey_path,omitempty"`
	SSHPubkeyFPSHA256 string   `json:"ssh_pubkey_fp_sha256,omitempty" yaml:"ssh_pubkey_fp_sha256,omitempty"`
	WriteProfile      string   `json:"write_profile,omitempty" yaml:"write_profile,omitempty"`
}

func (in *OperatorAddInput) Validate() error {
	in.Name = strings.TrimSpace(in.Name)
	in.Email = strings.TrimSpace(in.Email)
	if in.Name == "" {
		return errors.New("name is required")
	}
	if _, err := mail.ParseAddress(in.Email); err != nil {
		return fmt.Errorf("email %q invalid: %w", in.Email, err)
	}
	switch in.Role {
	case "":
		in.Role = "operator"
	case "operator", "admin", "readonly":
	default:
		return fmt.Errorf("role %q invalid (want operator|admin|readonly)", in.Role)
	}
	if len(in.Scopes) == 0 {
		in.Scopes = []string{"admin:read"}
	}
	for _, s := range in.Scopes {
		switch s {
		case "send", "messages:read", "imap_bridge:read", "admin:read", "admin:rotate", "admin:impersonate":
		default:
			return fmt.Errorf("scope %q invalid", s)
		}
	}
	if in.RateLimitPerMin <= 0 {
		in.RateLimitPerMin = 600
	}
	if in.SSHPubkey == "" && in.SSHPubkeyPath != "" {
		raw, err := os.ReadFile(in.SSHPubkeyPath)
		if err != nil {
			return fmt.Errorf("read ssh_pubkey_path %q: %w", in.SSHPubkeyPath, err)
		}
		in.SSHPubkey = strings.TrimSpace(string(raw))
	}
	if in.SSHPubkey == "" {
		return errors.New("ssh_pubkey or ssh_pubkey_path is required")
	}
	in.SSHPubkey = strings.TrimSpace(in.SSHPubkey)
	pk, _, _, _, err := ssh.ParseAuthorizedKey([]byte(in.SSHPubkey))
	if err != nil {
		return fmt.Errorf("ssh_pubkey parse failed (expect single authorized_keys line): %w", err)
	}
	computed := SSHFingerprintSHA256(pk)
	if in.SSHPubkeyFPSHA256 != "" && in.SSHPubkeyFPSHA256 != computed {
		return fmt.Errorf("ssh_pubkey_fp_sha256 mismatch: file says %q, computed %q",
			in.SSHPubkeyFPSHA256, computed)
	}
	in.SSHPubkeyFPSHA256 = computed
	return nil
}

// SSHFingerprintSHA256 emits `SHA256:<base64-no-padding>` matching
// `ssh-keygen -E sha256 -lf <pubkey>`.
func SSHFingerprintSHA256(pk ssh.PublicKey) string {
	sum := sha256.Sum256(pk.Marshal())
	return "SHA256:" + base64.RawStdEncoding.EncodeToString(sum[:])
}

func LoadOperatorAddFile(path string) (*OperatorAddInput, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	in := &OperatorAddInput{}
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

func PromptOperatorAdd(initial *OperatorAddInput) (*OperatorAddInput, error) {
	in := &OperatorAddInput{Role: "operator", RateLimitPerMin: 600}
	if initial != nil {
		*in = *initial
	}
	if len(in.Scopes) == 0 {
		in.Scopes = []string{"admin:read"}
	}
	pubkeySource := "paste"
	if in.SSHPubkeyPath != "" && in.SSHPubkey == "" {
		pubkeySource = "file"
	}
	form := huh.NewForm(
		huh.NewGroup(
			huh.NewInput().
				Title("Operator name").
				Description("Display name shown in audit logs and the panel.").
				Value(&in.Name).
				Validate(func(s string) error {
					if strings.TrimSpace(s) == "" {
						return errors.New("name required")
					}
					return nil
				}),
			huh.NewInput().
				Title("Email").
				Description("Canonical contact + audit attribution.").
				Value(&in.Email).
				Validate(func(s string) error {
					if _, err := mail.ParseAddress(s); err != nil {
						return fmt.Errorf("invalid email: %w", err)
					}
					return nil
				}),
			huh.NewSelect[string]().
				Title("Role").
				Options(
					huh.NewOption("operator (day-to-day mgmt)", "operator"),
					huh.NewOption("admin (rotate keys, manage operators)", "admin"),
					huh.NewOption("readonly (look but don't touch)", "readonly"),
				).
				Value(&in.Role),
			huh.NewSelect[string]().
				Title("SSH key source").
				Options(
					huh.NewOption("paste the authorized_keys line", "paste"),
					huh.NewOption("read from a .pub file", "file"),
				).
				Value(&pubkeySource),
		),
	)
	if err := form.Run(); err != nil {
		return nil, err
	}
	switch pubkeySource {
	case "paste":
		pasteForm := huh.NewForm(huh.NewGroup(
			huh.NewText().
				Title("Paste the authorized_keys line").
				Description("e.g. `ssh-ed25519 AAAA... user@host`").
				Value(&in.SSHPubkey).
				Validate(func(s string) error {
					if strings.TrimSpace(s) == "" {
						return errors.New("required")
					}
					if _, _, _, _, err := ssh.ParseAuthorizedKey([]byte(strings.TrimSpace(s))); err != nil {
						return fmt.Errorf("not a valid authorized_keys line: %w", err)
					}
					return nil
				}),
		))
		if err := pasteForm.Run(); err != nil {
			return nil, err
		}
	case "file":
		fileForm := huh.NewForm(huh.NewGroup(
			huh.NewFilePicker().
				Title("Path to .pub file").
				Description("e.g. ~/.ssh/id_ed25519.pub").
				ShowHidden(false).
				AllowedTypes([]string{".pub", ""}).
				Value(&in.SSHPubkeyPath),
		))
		if err := fileForm.Run(); err != nil {
			return nil, err
		}
	}
	scopesForm := huh.NewForm(huh.NewGroup(
		huh.NewMultiSelect[string]().
			Title("API scopes for this operator's key").
			Description("Use space to toggle, enter to confirm.").
			Options(
				huh.NewOption("admin:read (list/inspect)", "admin:read"),
				huh.NewOption("admin:rotate (mutate, create operators)", "admin:rotate"),
				huh.NewOption("admin:impersonate (Wish server only)", "admin:impersonate"),
				huh.NewOption("messages:read", "messages:read"),
				huh.NewOption("send", "send"),
				huh.NewOption("imap_bridge:read (bridge sidecar)", "imap_bridge:read"),
			).
			Value(&in.Scopes).
			Validate(func(v []string) error {
				if len(v) == 0 {
					return errors.New("pick at least one scope")
				}
				return nil
			}),
	))
	if err := scopesForm.Run(); err != nil {
		return nil, err
	}
	return in, in.Validate()
}

func RunOperatorAdd(ctx context.Context, c *client.Client, in *OperatorAddInput, w io.Writer) (*client.OperatorIssueResponse, error) {
	if err := in.Validate(); err != nil {
		return nil, err
	}
	req := client.OperatorCreateRequest{
		Name:              in.Name,
		Email:             in.Email,
		SSHPubkey:         in.SSHPubkey,
		SSHPubkeyFPSHA256: in.SSHPubkeyFPSHA256,
		Role:              in.Role,
		Scopes:            in.Scopes,
		RateLimitPerMin:   in.RateLimitPerMin,
	}
	var out client.OperatorIssueResponse
	if err := c.DoJSON(ctx, "POST", "/v1/admin/operators", nil, req, &out); err != nil {
		return nil, err
	}
	if c.DryRun {
		fmt.Fprintln(w, "(dry-run; no operator was created)")
		return nil, nil
	}
	fmt.Fprintf(w, "✓ Operator created: %s <%s> (%s)\n", in.Name, in.Email, out.Operator.ID)
	fmt.Fprintf(w, "  Role:        %s\n", in.Role)
	fmt.Fprintf(w, "  Scopes:      %s\n", strings.Join(in.Scopes, ", "))
	fmt.Fprintf(w, "  Fingerprint: %s\n", in.SSHPubkeyFPSHA256)
	fmt.Fprintf(w, "  API key:     %s\n", out.APIKeyID)
	fmt.Fprintln(w)
	fmt.Fprintln(w, "Login token (paste into `polaris-mail login`):")
	fmt.Fprintln(w)
	fmt.Fprintf(w, "  %s\n", out.LoginToken)
	fmt.Fprintln(w)
	fmt.Fprintln(w, "↑ This is shown ONCE. Save it now or hand it to the new operator.")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "Next steps for the new operator:")
	fmt.Fprintln(w, "  1. polaris-mail login          # paste the token above")
	fmt.Fprintln(w, "  2. polaris-mail whoami         # confirm identity")
	return &out, nil
}
