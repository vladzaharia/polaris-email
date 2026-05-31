package bridge

import (
	"fmt"
	"strconv"

	"github.com/charmbracelet/huh"
)

// Prompt runs the interactive wizard. The seed carries any flags the
// operator passed; everything not pre-populated is asked. The Mode
// select intentionally has NO default — both modes are first-class and
// the operator must choose explicitly.
//
// cliVersion stamps the ImageTag default when the operator does not
// override via flag.
func Prompt(seed *BridgeSetupInput, cliVersion string) (*BridgeSetupInput, error) {
	in := &BridgeSetupInput{}
	if seed != nil {
		*in = *seed
	}

	// Stage 1: mode + bridge identity.
	var modeStr string
	if in.Mode != "" {
		modeStr = string(in.Mode)
	}
	stage1 := huh.NewForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title("Deployment mode").
				Description("Both modes are first-class deployments — see apps/mail-bridge/README.md for a side-by-side comparison.").
				Options(
					huh.NewOption("local — bridge binds protocol ports on the host (operator owns firewall + TLS)", "local"),
					huh.NewOption("tailscale — bridge runs inside a Tailscale sidecar (tailnet-only access)", "tailscale"),
				).
				Value(&modeStr),
			huh.NewInput().Title("Bridge name").Description("e.g. bridge-iad-1 — lowercase alphanumeric + dashes").
				Value(&in.BridgeName).Validate(func(s string) error {
				if !isValidBridgeName(s) {
					return fmt.Errorf("invalid bridge name")
				}
				return nil
			}),
			huh.NewSelect[string]().Title("Environment").
				Options(
					huh.NewOption("prod", "prod"),
					huh.NewOption("staging", "staging"),
					huh.NewOption("dev", "dev"),
				).Value(&in.Environment),
			huh.NewInput().Title("Polaris API URL").Description("Control-plane base, e.g. https://api.polaris.example.com").
				Value(&in.PolarisAPIURL),
		),
	)
	if err := stage1.Run(); err != nil {
		return nil, err
	}
	in.Mode = Mode(modeStr)

	// Stage 2: per-mode TLS source + FQDN + public URL.
	tlsOptions := []huh.Option[string]{
		huh.NewOption("mounted — operator-managed PEM at $BRIDGE_TLS_DIR", string(TLSMounted)),
		huh.NewOption("lego — DNS-01 via Cloudflare", string(TLSLego)),
	}
	if in.Mode == ModeTailscale {
		// Tailscale sidecar TLS is only meaningful when mode=tailscale.
		tlsOptions = []huh.Option[string]{
			huh.NewOption("tailscale-sidecar — TLS via tsnet.ListenTLS (recommended)", string(TLSTailscaleSidecar)),
			huh.NewOption("lego — DNS-01 fallback (cert path mounted at /etc/polaris-bridge/tls)", string(TLSLego)),
		}
	}
	var tlsStr string
	if in.TLSSource != "" {
		tlsStr = string(in.TLSSource)
	}
	stage2 := huh.NewForm(
		huh.NewGroup(
			huh.NewSelect[string]().Title("TLS source").Options(tlsOptions...).Value(&tlsStr),
			huh.NewInput().Title("FQDN").Description("SAN on the bridge's server cert").Value(&in.FQDN),
		),
	)
	if err := stage2.Run(); err != nil {
		return nil, err
	}
	in.TLSSource = TLSSource(tlsStr)

	// Stage 3: mode-specific extras.
	switch in.Mode {
	case ModeTailscale:
		if err := huh.NewForm(huh.NewGroup(
			huh.NewInput().Title("Tailscale region").Description("Hostname suffix: polaris-mail-<REGION>.<tailnet>.ts.net").
				Value(&in.Region),
		)).Run(); err != nil {
			return nil, err
		}
	}
	if in.TLSSource == TLSLego {
		if err := huh.NewForm(huh.NewGroup(
			huh.NewInput().Title("ACME contact email").Value(&in.ACMEEmail),
		)).Run(); err != nil {
			return nil, err
		}
	}

	// Stage 4: port mapping.
	smtps := strconv.Itoa(in.SMTPSPort)
	imap := strconv.Itoa(in.IMAPPort)
	webhook := strconv.Itoa(in.WebhookPort)
	if smtps == "0" {
		smtps = "465"
	}
	if imap == "0" {
		imap = "993"
	}
	if webhook == "0" {
		webhook = "8080"
	}
	if err := huh.NewForm(huh.NewGroup(
		huh.NewInput().Title("SMTPS host port").Value(&smtps).Validate(validatePort),
		huh.NewInput().Title("IMAP host port").Value(&imap).Validate(validatePort),
		huh.NewInput().Title("Webhook host port").Value(&webhook).Validate(validatePort),
	)).Run(); err != nil {
		return nil, err
	}
	in.SMTPSPort, _ = strconv.Atoi(smtps)
	in.IMAPPort, _ = strconv.Atoi(imap)
	in.WebhookPort, _ = strconv.Atoi(webhook)

	in.Defaults(cliVersion)
	return in, in.Validate()
}

func validatePort(s string) error {
	p, err := strconv.Atoi(s)
	if err != nil {
		return fmt.Errorf("not a number")
	}
	if p <= 0 || p > 65535 {
		return fmt.Errorf("out of range")
	}
	return nil
}
