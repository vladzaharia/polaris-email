// Package bridge implements the mail-bridge daemon descriptor for
// `polaris-mail setup bridge`. It owns the wizard prompts, the
// compose/env/bridge.toml templates, prechecks, post-up health probes,
// and the on-disk layout in `<dir>/`.
package bridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

// Mode is the deployment mode. Both are first-class — the wizard must
// never pre-select one. See CLAUDE.md "mail-bridge: two equally-
// supported deployment modes" for the architectural rationale.
type Mode string

const (
	ModeLocal     Mode = "local"
	ModeTailscale Mode = "tailscale"
)

// TLSSource describes how the bridge gets its server TLS material.
type TLSSource string

const (
	// TLSMounted = operator owns the PEMs and mounts them at $BRIDGE_TLS_DIR.
	TLSMounted TLSSource = "mounted"
	// TLSLego = lego container issues DNS-01 certs via Cloudflare.
	TLSLego TLSSource = "lego"
	// TLSTailscaleSidecar = Tailscale tsnet ListenTLS handles TLS.
	TLSTailscaleSidecar TLSSource = "tailscale-sidecar"
)

// BridgeSetupInput captures every operator decision the wizard collects.
// JSON tags drive `--from-file` parsing; the `validate` tags are
// documentation-only (we hand-roll Validate() because adding a
// validation library is overkill for ~10 fields).
type BridgeSetupInput struct {
	// Mode is the deployment mode. Required. No default — the operator
	// must choose explicitly.
	Mode Mode `json:"mode" yaml:"mode"`

	// BridgeName is the control-plane identifier. Required; lowercased
	// alphanumeric + dashes.
	BridgeName string `json:"bridge_name" yaml:"bridge_name"`

	// Environment is the bridge registration environment.
	Environment string `json:"environment" yaml:"environment"`

	// PolarisAPIURL is the control-plane base URL the bridge talks to.
	PolarisAPIURL string `json:"polaris_api_url" yaml:"polaris_api_url"`

	// PublicURL is the operator-routable URL polaris fanout POSTs the
	// webhook to. Loopback-only addresses are rejected.
	PublicURL string `json:"public_url" yaml:"public_url"`

	// TLSSource picks the source of TLS material. Valid combinations
	// with Mode are enforced by Validate.
	TLSSource TLSSource `json:"tls_source" yaml:"tls_source"`

	// FQDN is the SAN on the cert / lego hostname / cf-access target.
	FQDN string `json:"fqdn" yaml:"fqdn"`

	// SMTPSPort / IMAPPort / WebhookPort are host-side port mappings.
	SMTPSPort   int `json:"smtps_port" yaml:"smtps_port"`
	IMAPPort    int `json:"imap_port" yaml:"imap_port"`
	WebhookPort int `json:"webhook_port" yaml:"webhook_port"`

	// TLSDir is the on-host directory mounted at /etc/polaris-bridge/tls
	// (mounted TLS only). Defaults to "./tls" if empty.
	TLSDir string `json:"tls_dir,omitempty" yaml:"tls_dir,omitempty"`

	// ACMEEmail is the lego --email argument (lego TLS only).
	ACMEEmail string `json:"acme_email,omitempty" yaml:"acme_email,omitempty"`

	// Region is the Tailscale hostname suffix (tailscale mode only).
	Region string `json:"region,omitempty" yaml:"region,omitempty"`

	// ImageTag pins ghcr.io/vladzaharia/polaris-mail-bridge:<tag>.
	// Defaults to the CLI's compiled-in Version constant when empty
	// (see Defaults).
	ImageTag string `json:"image_tag" yaml:"image_tag"`

	// Dir is the on-host directory the wizard writes everything to.
	// Defaults to "./polaris-bridge".
	Dir string `json:"dir,omitempty" yaml:"dir,omitempty"`
}

// Defaults stamps the zero-value defaults that depend on the runtime
// CLI version. ImageTag is taken from the supplied cliVersion when
// empty so a `polaris-mail v1.2.3` run reliably renders v1.2.3
// compose files (and not stale :latest).
func (in *BridgeSetupInput) Defaults(cliVersion string) {
	if in.Environment == "" {
		in.Environment = "prod"
	}
	if in.SMTPSPort == 0 {
		in.SMTPSPort = 465
	}
	if in.IMAPPort == 0 {
		in.IMAPPort = 993
	}
	if in.WebhookPort == 0 {
		in.WebhookPort = 8080
	}
	if in.ImageTag == "" {
		in.ImageTag = cliVersion
	}
	if in.Dir == "" {
		in.Dir = "./polaris-bridge"
	}
	if in.TLSDir == "" && (in.TLSSource == TLSMounted || in.TLSSource == TLSLego) {
		in.TLSDir = "./tls"
	}
	if in.Region == "" && in.Mode == ModeTailscale {
		in.Region = "us-east"
	}
}

// Validate enforces cross-field rules. Run after Defaults.
func (in *BridgeSetupInput) Validate() error {
	switch in.Mode {
	case ModeLocal, ModeTailscale:
	case "":
		return errors.New("mode is required (local|tailscale)")
	default:
		return fmt.Errorf("mode %q invalid (want local|tailscale)", in.Mode)
	}
	if strings.TrimSpace(in.BridgeName) == "" {
		return errors.New("bridge_name is required")
	}
	if !isValidBridgeName(in.BridgeName) {
		return fmt.Errorf("bridge_name %q invalid (want lowercase alphanumeric + dashes, 3-63 chars)", in.BridgeName)
	}
	switch in.Environment {
	case "prod", "staging", "dev":
	default:
		return fmt.Errorf("environment %q invalid (want prod|staging|dev)", in.Environment)
	}
	if _, err := url.Parse(in.PolarisAPIURL); err != nil || in.PolarisAPIURL == "" {
		return fmt.Errorf("polaris_api_url %q invalid: %v", in.PolarisAPIURL, err)
	}
	if !strings.HasPrefix(in.PolarisAPIURL, "http://") && !strings.HasPrefix(in.PolarisAPIURL, "https://") {
		return fmt.Errorf("polaris_api_url must be http(s)://...")
	}
	pub, err := url.Parse(in.PublicURL)
	if err != nil || in.PublicURL == "" {
		return fmt.Errorf("public_url %q invalid: %v", in.PublicURL, err)
	}
	if pub.Scheme != "http" && pub.Scheme != "https" {
		return fmt.Errorf("public_url must be http(s)://...")
	}
	if isLoopbackHost(pub.Hostname()) {
		return fmt.Errorf("public_url %q points at loopback; polaris fanout cannot reach it from outside this host", in.PublicURL)
	}
	switch in.TLSSource {
	case TLSMounted, TLSLego, TLSTailscaleSidecar:
	case "":
		return errors.New("tls_source is required (mounted|lego|tailscale-sidecar)")
	default:
		return fmt.Errorf("tls_source %q invalid", in.TLSSource)
	}
	// Mode/TLS-source combination matrix.
	switch in.Mode {
	case ModeLocal:
		if in.TLSSource == TLSTailscaleSidecar {
			return fmt.Errorf("tls_source=tailscale-sidecar requires mode=tailscale")
		}
	case ModeTailscale:
		// Lego is permitted as a fallback under tailscale mode (see
		// docker-compose.tailscale.yml comments). Mounted-PEM is not —
		// the operator should switch to local mode in that case.
		if in.TLSSource == TLSMounted {
			return fmt.Errorf("tls_source=mounted under mode=tailscale is not supported; use mode=local instead")
		}
	}
	if in.FQDN == "" {
		return errors.New("fqdn is required")
	}
	for label, p := range map[string]int{"smtps_port": in.SMTPSPort, "imap_port": in.IMAPPort, "webhook_port": in.WebhookPort} {
		if p <= 0 || p > 65535 {
			return fmt.Errorf("%s %d out of range", label, p)
		}
	}
	if in.TLSSource == TLSLego {
		if !strings.Contains(in.ACMEEmail, "@") {
			return fmt.Errorf("acme_email %q invalid", in.ACMEEmail)
		}
	}
	if in.ImageTag == "" {
		return errors.New("image_tag is required (set --image-tag or build with goreleaser ldflags)")
	}
	return nil
}

func isValidBridgeName(s string) bool {
	if len(s) < 3 || len(s) > 63 {
		return false
	}
	if s[0] == '-' || s[len(s)-1] == '-' {
		return false
	}
	for _, r := range s {
		if !(r == '-' || (r >= '0' && r <= '9') || (r >= 'a' && r <= 'z')) {
			return false
		}
	}
	return true
}

// isLoopbackHost rejects host:port URLs that resolve to 127.0.0.0/8, ::1
// or "localhost".
func isLoopbackHost(host string) bool {
	if host == "" {
		return false
	}
	if strings.EqualFold(host, "localhost") {
		return true
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		return true
	}
	return false
}

// LoadInputFile parses --from-file payload (json or yaml).
func LoadInputFile(path string) (*BridgeSetupInput, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	in := &BridgeSetupInput{}
	if strings.HasSuffix(path, ".json") {
		if err := json.Unmarshal(data, in); err != nil {
			return nil, err
		}
	} else {
		if err := yaml.Unmarshal(data, in); err != nil {
			return nil, err
		}
	}
	return in, nil
}

// --- setup.Input implementation -------------------------------------
//
// BridgeSetupInput satisfies internal/setup.Input via these adapter
// methods so the generic cobra generator can drive the bridge
// descriptor without importing this package's concrete types.
//
// Note: the struct has a `Mode Mode` field (deployment mode) so the
// Input.Mode() method ends up named ModeString() here and the
// descriptor.Mode() method projects this string onto the interface
// surface via an inputWrapper.

// Marshal serialises the input to JSON. Used by the snapshot writer in
// `<dir>/.polaris-setup.json` and by the --from-file round-trip test.
func (in *BridgeSetupInput) Marshal() ([]byte, error) {
	return json.Marshal(in)
}

// Unmarshal is the JSON-only inverse of Marshal. The bridge package
// preserves a YAML path via LoadInputFile() for operator-supplied
// snapshots — the setup.Input contract only requires JSON parity, so
// this method does not try to sniff YAML.
func (in *BridgeSetupInput) Unmarshal(data []byte) error {
	return json.Unmarshal(data, in)
}

// ModeString returns the deployment mode label ("local" | "tailscale").
// Empty when the input has not been populated yet. The setup.Input
// interface requires a method literally called Mode(); a thin wrapper
// in descriptor.go projects ModeString onto that surface (we cannot
// shadow the `Mode Mode` field with a same-named method).
func (in *BridgeSetupInput) ModeString() string {
	return string(in.Mode)
}
