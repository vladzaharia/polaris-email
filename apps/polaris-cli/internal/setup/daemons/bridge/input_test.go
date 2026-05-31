package bridge

import (
	"strings"
	"testing"
)

func validInput() *BridgeSetupInput {
	in := &BridgeSetupInput{
		Mode:          ModeLocal,
		BridgeName:    "bridge-iad-1",
		Environment:   "prod",
		PolarisAPIURL: "https://api.polaris.example.com",
		TLSSource:     TLSMounted,
		FQDN:          "mail.example.com",
		ImageTag:      "v1.2.3",
	}
	in.Defaults("v1.2.3")
	return in
}

func TestValidate_OK(t *testing.T) {
	if err := validInput().Validate(); err != nil {
		t.Fatalf("expected ok, got %v", err)
	}
}

func TestValidate_TableErrors(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(in *BridgeSetupInput)
		want   string
	}{
		{"missing-mode", func(in *BridgeSetupInput) { in.Mode = "" }, "mode is required"},
		{"bad-mode", func(in *BridgeSetupInput) { in.Mode = "weird" }, "mode \"weird\" invalid"},
		{"missing-name", func(in *BridgeSetupInput) { in.BridgeName = "" }, "bridge_name is required"},
		{"uppercase-name", func(in *BridgeSetupInput) { in.BridgeName = "Bridge1" }, "bridge_name \"Bridge1\" invalid"},
		{"too-short-name", func(in *BridgeSetupInput) { in.BridgeName = "br" }, "bridge_name \"br\" invalid"},
		{"trailing-dash-name", func(in *BridgeSetupInput) { in.BridgeName = "bridge-1-" }, "bridge_name \"bridge-1-\" invalid"},
		{"bad-env", func(in *BridgeSetupInput) { in.Environment = "qa" }, "environment \"qa\" invalid"},
		{"missing-api-url", func(in *BridgeSetupInput) { in.PolarisAPIURL = "" }, "polaris_api_url"},
		{"non-http-api-url", func(in *BridgeSetupInput) { in.PolarisAPIURL = "ftp://x" }, "polaris_api_url must be http(s)"},
		{"missing-tls-source", func(in *BridgeSetupInput) { in.TLSSource = "" }, "tls_source is required"},
		{"bad-tls-source", func(in *BridgeSetupInput) { in.TLSSource = "weird" }, "tls_source \"weird\" invalid"},
		{"local+tailscale-sidecar", func(in *BridgeSetupInput) {
			in.Mode = ModeLocal
			in.TLSSource = TLSTailscaleSidecar
		}, "tls_source=tailscale-sidecar requires mode=tailscale"},
		{"tailscale+mounted", func(in *BridgeSetupInput) {
			in.Mode = ModeTailscale
			in.TLSSource = TLSMounted
		}, "mode=local instead"},
		{"missing-fqdn", func(in *BridgeSetupInput) { in.FQDN = "" }, "fqdn is required"},
		{"bad-smtps-port", func(in *BridgeSetupInput) { in.SMTPSPort = 70000 }, "out of range"},
		{"lego-missing-acme-email", func(in *BridgeSetupInput) {
			in.TLSSource = TLSLego
			in.ACMEEmail = ""
		}, "acme_email"},
		{"missing-image-tag", func(in *BridgeSetupInput) { in.ImageTag = "" }, "image_tag is required"},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			in := validInput()
			tt.mutate(in)
			err := in.Validate()
			if err == nil {
				t.Fatalf("expected error containing %q, got nil", tt.want)
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("error %q does not contain %q", err.Error(), tt.want)
			}
		})
	}
}

func TestDefaults(t *testing.T) {
	in := &BridgeSetupInput{Mode: ModeTailscale, TLSSource: TLSLego}
	in.Defaults("v9.9.9")
	if in.ImageTag != "v9.9.9" {
		t.Fatalf("image tag = %q", in.ImageTag)
	}
	if in.SMTPSPort != 465 || in.IMAPPort != 993 || in.WebhookPort != 8080 {
		t.Fatalf("default ports wrong: %+v", in)
	}
	if in.Environment != "prod" {
		t.Fatalf("default env = %q", in.Environment)
	}
	if in.Region == "" {
		t.Fatalf("tailscale mode must default Region")
	}
	if in.TLSDir == "" {
		t.Fatalf("lego TLS must default TLSDir")
	}
}

func TestDefaults_DoesNotOverwriteExisting(t *testing.T) {
	in := &BridgeSetupInput{
		Mode:        ModeLocal,
		TLSSource:   TLSMounted,
		SMTPSPort:   2465,
		IMAPPort:    2993,
		WebhookPort: 18080,
		ImageTag:    "v1.0.0",
		Region:      "eu-west",
		TLSDir:      "/etc/custom/tls",
		Environment: "dev",
	}
	in.Defaults("v2.0.0")
	if in.ImageTag != "v1.0.0" {
		t.Fatalf("Defaults overwrote ImageTag: %q", in.ImageTag)
	}
	if in.SMTPSPort != 2465 || in.IMAPPort != 2993 || in.WebhookPort != 18080 {
		t.Fatalf("Defaults overwrote ports: %+v", in)
	}
	if in.Region != "eu-west" || in.TLSDir != "/etc/custom/tls" || in.Environment != "dev" {
		t.Fatalf("Defaults overwrote operator value: %+v", in)
	}
}
