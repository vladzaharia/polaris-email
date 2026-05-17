package wranglercfg

import (
	"strings"
	"testing"
)

func TestValidate_AllPresent(t *testing.T) {
	t.Parallel()
	in := fullyPopulatedInputs()
	if err := in.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
}

func TestValidate_ReportsEveryMissingField(t *testing.T) {
	t.Parallel()
	// Empty inputs — every required field should be reported.
	in := &RenderInputs{}
	err := in.Validate()
	if err == nil {
		t.Fatal("Validate: want error on empty inputs")
	}
	for _, want := range []string{
		"Account.ID",
		"Hostnames.PolarisAPI",
		"Hostnames.R2Public",
		"D1.PolarisEmail.ID",
		"KV.Nonce.ID",
		"KV.Idempotency.ID",
		"KV.RateLimit.ID",
		"KV.KeyCache.ID",
		"KV.Revocations.ID",
		"Anchor.S3Endpoint",
		"Anchor.S3Bucket",
		"Anchor.S3Region",
		"AlertWebhook",
		"OIDC.Issuer",
		"OIDC.ClientID",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("Validate error missing %q in:\n%v", want, err)
		}
	}
}

func TestValidate_MentionsEnvAndStateNames(t *testing.T) {
	t.Parallel()
	// The error message has to be actionable — the operator should not
	// have to grep the Go source to figure out what env var or state
	// key they need to set. Spot-check a few of those breadcrumbs.
	in := &RenderInputs{}
	err := in.Validate()
	if err == nil {
		t.Fatal("Validate: want error on empty inputs")
	}
	for _, want := range []string{
		"CF_ACCOUNT_ID",
		"POLARIS_API_HOSTNAME",
		"R2_PUBLIC_HOST",
		"ANCHOR_S3_ENDPOINT",
		"OIDC_ISSUER",
		`state .d1["polaris-email"].id`,
		`state .kv["polaris-email-nonce"].id`,
	} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error missing actionable breadcrumb %q:\n%v", want, err)
		}
	}
}

func TestValidate_WhitespaceOnlyCountsAsMissing(t *testing.T) {
	t.Parallel()
	in := fullyPopulatedInputs()
	in.Account.ID = "   "
	err := in.Validate()
	if err == nil || !strings.Contains(err.Error(), "Account.ID") {
		t.Fatalf("whitespace Account.ID should be rejected, got: %v", err)
	}
}

// fullyPopulatedInputs returns inputs that satisfy Validate. Tests that
// want to exercise specific failures start here and zero out one field.
func fullyPopulatedInputs() *RenderInputs {
	return &RenderInputs{
		Account: AccountInputs{ID: "cf-account-id"},
		D1: D1Inputs{
			PolarisEmail: D1Database{ID: "d1-id", Name: "polaris-email"},
		},
		R2: R2Inputs{
			PolarisEmail: R2Bucket{Name: "polaris-email", Jurisdiction: "eu"},
		},
		KV: KVInputs{
			Nonce:       KVNamespace{ID: "kv-nonce-id", Name: "polaris-email-nonce"},
			Idempotency: KVNamespace{ID: "kv-idem-id", Name: "polaris-email-idempotency"},
			RateLimit:   KVNamespace{ID: "kv-rl-id", Name: "polaris-email-rate-limit"},
			KeyCache:    KVNamespace{ID: "kv-kc-id", Name: "polaris-email-key-cache"},
			Revocations: KVNamespace{ID: "kv-rev-id", Name: "polaris-email-revocations"},
		},
		Hostnames: HostnameInputs{
			PolarisAPI: "api.example.com",
			R2Public:   "r2.example.com",
			Bridge:     "bridge.example.com",
		},
		Synthetic: SyntheticInputs{
			From:          "synthetic@example.com",
			To:            "synthetic@in.example.com",
			MonitorDomain: "example.com",
		},
		Anchor: AnchorInputs{
			S3Endpoint: "https://s3.example.com",
			S3Bucket:   "polaris-anchors",
			S3Region:   "us-west-005",
		},
		OIDC: OIDCInputs{
			Issuer:   "https://oidc.example.com",
			ClientID: "client-abc",
		},
		AlertWebhook: "https://alerts.example.com/hook",
	}
}
