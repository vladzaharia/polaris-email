package wizards

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"text/template"

	"github.com/charmbracelet/huh"
	"gopkg.in/yaml.v3"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
)

// BridgeRegisterInput is the validated input for `polaris-mail bridge register`.
type BridgeRegisterInput struct {
	Name        string `json:"name" yaml:"name"`
	Environment string `json:"environment" yaml:"environment"`                     // prod|staging|dev
	OutputForm  string `json:"output_form,omitempty" yaml:"output_form,omitempty"` // compose|systemd
	WriteFile   string `json:"write_file,omitempty" yaml:"write_file,omitempty"`   // optional path for registration.json
}

func (in *BridgeRegisterInput) Validate() error {
	if strings.TrimSpace(in.Name) == "" {
		return errors.New("name is required")
	}
	switch in.Environment {
	case "prod", "staging", "dev":
	case "":
		in.Environment = "prod"
	default:
		return fmt.Errorf("environment %q invalid (want prod|staging|dev)", in.Environment)
	}
	switch in.OutputForm {
	case "", "compose":
		in.OutputForm = "compose"
	case "systemd":
	default:
		return fmt.Errorf("output_form %q invalid (want compose|systemd)", in.OutputForm)
	}
	return nil
}

// LoadBridgeRegisterFile parses --from-file payload.
func LoadBridgeRegisterFile(path string) (*BridgeRegisterInput, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	in := &BridgeRegisterInput{}
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

// PromptBridgeRegister runs the interactive wizard.
func PromptBridgeRegister(initial *BridgeRegisterInput) (*BridgeRegisterInput, error) {
	in := &BridgeRegisterInput{Environment: "prod", OutputForm: "compose"}
	if initial != nil {
		*in = *initial
	}
	form := huh.NewForm(
		huh.NewGroup(
			huh.NewInput().Title("Bridge name (e.g., bridge-iad-1)").Value(&in.Name),
			huh.NewSelect[string]().Title("Environment").
				Options(
					huh.NewOption("prod", "prod"),
					huh.NewOption("staging", "staging"),
					huh.NewOption("dev", "dev"),
				).Value(&in.Environment),
			huh.NewSelect[string]().Title("Install snippet form").
				Options(
					huh.NewOption("docker-compose", "compose"),
					huh.NewOption("systemd unit", "systemd"),
				).Value(&in.OutputForm),
		),
	)
	if err := form.Run(); err != nil {
		return nil, err
	}
	return in, in.Validate()
}

// RunBridgeRegister performs the API call and renders the install snippet.
func RunBridgeRegister(ctx context.Context, c *client.Client, in *BridgeRegisterInput, w io.Writer) (*client.BridgeRegisterResponse, error) {
	req := client.BridgeRegisterRequest{Name: in.Name, Environment: in.Environment}
	var out client.BridgeRegisterResponse
	if err := c.DoJSON(ctx, "POST", "/v1/admin/bridges", nil, req, &out); err != nil {
		return nil, err
	}
	if c.DryRun {
		fmt.Fprintln(w, "(dry-run; no bridge was registered)")
		return nil, nil
	}
	if in.WriteFile != "" {
		raw, _ := json.MarshalIndent(out, "", "  ")
		if err := os.WriteFile(in.WriteFile, raw, 0o600); err != nil {
			return &out, fmt.Errorf("write registration.json: %w", err)
		}
	}
	return &out, RenderInstallSnippet(w, in.OutputForm, &out, c.BaseURL)
}

// RenderInstallSnippet writes either a docker-compose snippet or a systemd
// unit file with the freshly-minted secrets.
func RenderInstallSnippet(w io.Writer, form string, r *client.BridgeRegisterResponse, apiURL string) error {
	switch form {
	case "compose":
		return composeTpl.Execute(w, struct {
			APIURL    string
			Bridge    client.Bridge
			HMACKeyID string
			HMACSec   string
			AccID     string
			AccSecret string
		}{apiURL, r.Bridge, r.HMACKeyID, r.HMACSecret, r.AccessClient, r.AccessToken})
	case "systemd":
		return systemdTpl.Execute(w, struct {
			APIURL    string
			Bridge    client.Bridge
			HMACKeyID string
			HMACSec   string
			AccID     string
			AccSecret string
		}{apiURL, r.Bridge, r.HMACKeyID, r.HMACSecret, r.AccessClient, r.AccessToken})
	}
	return fmt.Errorf("unknown form %q", form)
}

var composeTpl = template.Must(template.New("compose").Parse(`# Add to your docker-compose.yml. Secrets shown ONCE — store them now.
services:
  bridge:
    image: ghcr.io/vladzaharia/polaris-mail-bridge:latest
    network_mode: service:ts
    environment:
      API_BASE_URL: "{{.APIURL}}"
      BRIDGE_ID: "{{.Bridge.ID}}"
      BRIDGE_NAME: "{{.Bridge.Name}}"
      ENVIRONMENT: "{{.Bridge.Environment}}"
      BRIDGE_HMAC_KEY_ID: "{{.HMACKeyID}}"
      BRIDGE_HMAC_SECRET: "{{.HMACSec}}"
      CF_ACCESS_CLIENT_ID: "{{.AccID}}"
      CF_ACCESS_CLIENT_SECRET: "{{.AccSecret}}"
    volumes:
      - ./certs:/certs:ro
      - ./bridge-data:/data
`))

var systemdTpl = template.Must(template.New("systemd").Parse(`# /etc/systemd/system/polaris-mail-bridge.service. Secrets shown ONCE — store them now.
[Unit]
Description=polaris-mail mail bridge (SMTPS + IMAP)
After=network-online.target

[Service]
Environment=API_BASE_URL={{.APIURL}}
Environment=BRIDGE_ID={{.Bridge.ID}}
Environment=BRIDGE_NAME={{.Bridge.Name}}
Environment=ENVIRONMENT={{.Bridge.Environment}}
Environment=BRIDGE_HMAC_KEY_ID={{.HMACKeyID}}
Environment=BRIDGE_HMAC_SECRET={{.HMACSec}}
Environment=CF_ACCESS_CLIENT_ID={{.AccID}}
Environment=CF_ACCESS_CLIENT_SECRET={{.AccSecret}}
ExecStart=/usr/local/bin/polaris-bridge
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`))
