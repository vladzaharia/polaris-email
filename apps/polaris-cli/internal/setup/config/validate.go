package config

import (
	"errors"
	"fmt"
	"net/mail"
	"net/url"
	"strings"
)

// ValidationError aggregates per-field validation failures. It implements
// error so the caller can use it directly; the Fields slice is exposed
// so renderers can group failures into a multi-line message.
type ValidationError struct {
	Fields []FieldError
}

// FieldError ties a Cause to a particular .env.deploy key.
type FieldError struct {
	Key   string
	Cause string
}

// Error renders the multi-field validation failure as a single line.
// Tests string-match on the key list — keep the format stable.
func (v *ValidationError) Error() string {
	parts := make([]string, len(v.Fields))
	for i, f := range v.Fields {
		parts[i] = fmt.Sprintf("%s: %s", f.Key, f.Cause)
	}
	return "config: invalid — " + strings.Join(parts, "; ")
}

// add appends a field error.
func (v *ValidationError) add(key, cause string) {
	v.Fields = append(v.Fields, FieldError{Key: key, Cause: cause})
}

// HasErrors reports whether any field errors were collected.
func (v *ValidationError) HasErrors() bool { return len(v.Fields) > 0 }

// Validate runs every required-field check + cross-field rule and
// returns either nil or a non-empty *ValidationError. The function is
// pure — no side effects, safe to call from prompt loops or CI gates.
//
// Required fields:
//   - CF_ACCOUNT_ID, POLARIS_API_HOSTNAME (preflight enforces too)
//
// Cross-field rules:
//   - If any ANCHOR_S3_* secret is set, both ID + secret must be set
//   - SYNTHETIC_FROM / SYNTHETIC_TO must parse as email addresses if non-empty
//   - OIDC_ISSUER / ALERT_WEBHOOK / ANCHOR_S3_ENDPOINT must parse as URLs
//     if non-empty
func Validate(c *Config) error {
	if c == nil {
		return errors.New("config: Validate requires a non-nil *Config")
	}
	v := &ValidationError{}

	if strings.TrimSpace(c.CFAccountID) == "" {
		v.add("CF_ACCOUNT_ID", "required")
	}
	if strings.TrimSpace(c.PolarisAPIHostname) == "" {
		v.add("POLARIS_API_HOSTNAME", "required")
	}

	// URL fields — only validate when non-empty (they're all optional).
	for _, f := range []struct {
		Key, Val string
	}{
		{"OIDC_ISSUER", c.OIDCIssuer},
		{"ALERT_WEBHOOK", c.AlertWebhook},
		{"ANCHOR_S3_ENDPOINT", c.AnchorS3Endpoint},
	} {
		if f.Val == "" {
			continue
		}
		u, err := url.Parse(f.Val)
		if err != nil || u.Scheme == "" || u.Host == "" {
			v.add(f.Key, fmt.Sprintf("not a valid absolute URL: %q", f.Val))
		}
	}

	// Email fields.
	for _, f := range []struct {
		Key, Val string
	}{
		{"SYNTHETIC_FROM", c.SyntheticFrom},
		{"SYNTHETIC_TO", c.SyntheticTo},
	} {
		if f.Val == "" {
			continue
		}
		if _, err := mail.ParseAddress(f.Val); err != nil {
			v.add(f.Key, fmt.Sprintf("not a valid email address: %q", f.Val))
		}
	}

	// Hostnames — POLARIS_API_HOSTNAME, R2_PUBLIC_HOST, BRIDGE_HOST.
	// We reject anything containing scheme or path components — the
	// shell scripts assume bare hostnames.
	for _, f := range []struct {
		Key, Val string
	}{
		{"POLARIS_API_HOSTNAME", c.PolarisAPIHostname},
		{"R2_PUBLIC_HOST", c.R2PublicHost},
		{"BRIDGE_HOST", c.BridgeHost},
	} {
		if f.Val == "" {
			continue
		}
		if strings.ContainsAny(f.Val, " /\t") || strings.Contains(f.Val, "://") {
			v.add(f.Key, fmt.Sprintf("expected a bare hostname, got %q", f.Val))
		}
	}

	// Cross-field: B2 secret pair must be all-or-nothing.
	idSet := strings.TrimSpace(c.AnchorS3AccessKeyID) != ""
	secretSet := strings.TrimSpace(c.AnchorS3SecretAccessKey) != ""
	switch {
	case idSet && !secretSet:
		v.add("ANCHOR_S3_SECRET_ACCESS_KEY", "required when ANCHOR_S3_ACCESS_KEY_ID is set")
	case !idSet && secretSet:
		v.add("ANCHOR_S3_ACCESS_KEY_ID", "required when ANCHOR_S3_SECRET_ACCESS_KEY is set")
	}
	// Cross-field: if any B2 field is set, endpoint + bucket must be too.
	if idSet || secretSet {
		if strings.TrimSpace(c.AnchorS3Endpoint) == "" {
			v.add("ANCHOR_S3_ENDPOINT", "required when ANCHOR_S3_ACCESS_KEY_ID/SECRET is set")
		}
		if strings.TrimSpace(c.AnchorS3Bucket) == "" {
			v.add("ANCHOR_S3_BUCKET", "required when ANCHOR_S3_ACCESS_KEY_ID/SECRET is set")
		}
	}

	if v.HasErrors() {
		return v
	}
	return nil
}
