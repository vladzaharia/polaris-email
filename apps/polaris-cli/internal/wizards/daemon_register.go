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

// DaemonRegisterInput is the validated input for `polaris-email daemon register`.
type DaemonRegisterInput struct {
	Name        string `json:"name" yaml:"name"`
	Environment string `json:"environment" yaml:"environment"` // prod|staging|dev
	OutputForm  string `json:"output_form,omitempty" yaml:"output_form,omitempty"` // compose|systemd
	WriteFile   string `json:"write_file,omitempty" yaml:"write_file,omitempty"`   // optional path for registration.json
}

func (in *DaemonRegisterInput) Validate() error {
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

// LoadDaemonRegisterFile parses --from-file payload.
func LoadDaemonRegisterFile(path string) (*DaemonRegisterInput, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	in := &DaemonRegisterInput{}
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

// PromptDaemonRegister runs the interactive wizard.
func PromptDaemonRegister(initial *DaemonRegisterInput) (*DaemonRegisterInput, error) {
	in := &DaemonRegisterInput{Environment: "prod", OutputForm: "compose"}
	if initial != nil {
		*in = *initial
	}
	form := huh.NewForm(
		huh.NewGroup(
			huh.NewInput().Title("Daemon name (e.g., daemon-iad-1)").Value(&in.Name),
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

// RunDaemonRegister performs the API call and renders the install snippet.
func RunDaemonRegister(ctx context.Context, c *client.Client, in *DaemonRegisterInput, w io.Writer) (*client.DaemonRegisterResponse, error) {
	req := client.DaemonRegisterRequest{Name: in.Name, Environment: in.Environment}
	var out client.DaemonRegisterResponse
	if err := c.DoJSON(ctx, "POST", "/v1/admin/daemons", nil, req, &out); err != nil {
		return nil, err
	}
	if c.DryRun {
		fmt.Fprintln(w, "(dry-run; no daemon was registered)")
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
func RenderInstallSnippet(w io.Writer, form string, r *client.DaemonRegisterResponse, apiURL string) error {
	switch form {
	case "compose":
		return composeTpl.Execute(w, struct {
			APIURL    string
			Daemon    client.Daemon
			HMACKeyID string
			HMACSec   string
			AccID     string
			AccSecret string
		}{apiURL, r.Daemon, r.HMACKeyID, r.HMACSecret, r.AccessClient, r.AccessToken})
	case "systemd":
		return systemdTpl.Execute(w, struct {
			APIURL    string
			Daemon    client.Daemon
			HMACKeyID string
			HMACSec   string
			AccID     string
			AccSecret string
		}{apiURL, r.Daemon, r.HMACKeyID, r.HMACSecret, r.AccessClient, r.AccessToken})
	}
	return fmt.Errorf("unknown form %q", form)
}

var composeTpl = template.Must(template.New("compose").Parse(`# Add to your docker-compose.yml. Secrets shown ONCE — store them now.
services:
  submission:
    image: ghcr.io/vladzaharia/polaris-email-daemon:latest
    network_mode: service:ts
    environment:
      API_BASE_URL: "{{.APIURL}}"
      DAEMON_ID: "{{.Daemon.ID}}"
      DAEMON_NAME: "{{.Daemon.Name}}"
      ENVIRONMENT: "{{.Daemon.Environment}}"
      DAEMON_HMAC_KEY_ID: "{{.HMACKeyID}}"
      DAEMON_HMAC_SECRET: "{{.HMACSec}}"
      CF_ACCESS_CLIENT_ID: "{{.AccID}}"
      CF_ACCESS_CLIENT_SECRET: "{{.AccSecret}}"
    volumes:
      - ./certs:/certs:ro
      - ./submission-data:/data
`))

var systemdTpl = template.Must(template.New("systemd").Parse(`# /etc/systemd/system/polaris-daemon.service. Secrets shown ONCE — store them now.
[Unit]
Description=polaris-email submission daemon
After=network-online.target

[Service]
Environment=API_BASE_URL={{.APIURL}}
Environment=DAEMON_ID={{.Daemon.ID}}
Environment=DAEMON_NAME={{.Daemon.Name}}
Environment=ENVIRONMENT={{.Daemon.Environment}}
Environment=DAEMON_HMAC_KEY_ID={{.HMACKeyID}}
Environment=DAEMON_HMAC_SECRET={{.HMACSec}}
Environment=CF_ACCESS_CLIENT_ID={{.AccID}}
Environment=CF_ACCESS_CLIENT_SECRET={{.AccSecret}}
ExecStart=/usr/local/bin/polaris-daemon
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`))
