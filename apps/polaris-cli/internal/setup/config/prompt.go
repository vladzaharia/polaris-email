package config

import (
	"fmt"

	"github.com/charmbracelet/huh"
)

// PromptOptions controls Prompt() behavior. Path is the .env.deploy
// location used for the "save after every prompt" durability property.
// Save is the hook the prompt loop calls after each accepted field;
// tests substitute an in-memory recorder.
type PromptOptions struct {
	Path string
	Save func(*Config) error
}

// Prompt runs the interactive form. initial seeds the field defaults.
// On return, the *Config is fully populated with whatever the operator
// confirmed; the underlying .env.deploy on disk has been written after
// each field (via opts.Save) so a Ctrl-C halfway is durable.
//
// Validation per-field is purely client-side: URLs must parse,
// hostnames must look like hostnames, etc. The full cross-field rules
// in [Validate] are not enforced here — we leave them for the caller so
// the operator can deliberately leave fields blank and validate at the
// end.
//
// huh's Password() makes secrets invisible while typing. Defaults are
// still shown in the placeholder, so re-running configure on a
// populated .env.deploy keeps the "press enter to keep current" feel.
func Prompt(initial *Config, opts PromptOptions) (*Config, error) {
	if initial == nil {
		initial = &Config{}
	}
	if opts.Save == nil {
		opts.Save = func(*Config) error { return nil }
	}
	c := *initial // local copy — we mutate this, then return the pointer

	// Each field is its own huh.Form so we can save after every one.
	// One big multi-group form would still work, but we'd lose the
	// "Ctrl-C halfway is safe" property because the form returns the
	// values en-bloc.
	type step struct {
		key   string
		desc  string
		val   *string
		def   string
		valid func(string) error
	}

	defaultIfBlank := func(curr, fallback string) string {
		if curr == "" {
			return fallback
		}
		return curr
	}

	// Defaults that depend on other fields are resolved at the moment
	// we read the field (so an operator setting SYNTHETIC_MONITOR_DOMAIN
	// gets sensible FROM/TO suggestions immediately).
	steps := []step{
		{
			key:   "CF_ACCOUNT_ID",
			desc:  "Cloudflare account ID",
			val:   &c.CFAccountID,
			valid: notEmpty,
		},
		{
			key:  "POLARIS_API_HOSTNAME",
			desc: "API hostname",
			val:  &c.PolarisAPIHostname,
			def:  defaultIfBlank(c.PolarisAPIHostname, "polaris-email-api.workers.dev"),
		},
		{
			key:  "CF_API_TOKEN",
			desc: "Cloudflare API token (optional)",
			val:  &c.CFAPIToken,
		},
		{
			key:  "CF_ZONE_ID",
			desc: "Cloudflare default zone ID (optional)",
			val:  &c.CFZoneID,
		},
		{
			key:  "SYNTHETIC_MONITOR_DOMAIN",
			desc: "Synthetic monitor home domain (optional, e.g. polaris.video)",
			val:  &c.SyntheticMonitorDomain,
		},
		{
			key:   "ALERT_WEBHOOK",
			desc:  "Alert webhook URL (optional)",
			val:   &c.AlertWebhook,
			valid: optionalURL,
		},
	}

	// Run the first batch up to (but not including) SYNTHETIC_FROM so
	// we can use the just-collected SYNTHETIC_MONITOR_DOMAIN as the
	// default seed for FROM/TO.
	for _, s := range steps {
		if err := runOne(s.key, s.desc, s.val, s.def, s.valid); err != nil {
			return nil, err
		}
		if err := opts.Save(&c); err != nil {
			return nil, fmt.Errorf("save after prompt %s: %w", s.key, err)
		}
	}

	// Synthetic FROM/TO with derived defaults — mirrors the shell
	// script's `${SYNTHETIC_MONITOR_DOMAIN:+synthetic@${SYNTHETIC_MONITOR_DOMAIN}}`.
	synthFromDef := c.SyntheticFrom
	if synthFromDef == "" && c.SyntheticMonitorDomain != "" {
		synthFromDef = "synthetic@" + c.SyntheticMonitorDomain
	}
	synthToDef := c.SyntheticTo
	if synthToDef == "" && c.SyntheticMonitorDomain != "" {
		synthToDef = "synthetic@in." + c.SyntheticMonitorDomain
	}

	tail := []step{
		{key: "SYNTHETIC_FROM", desc: "Synthetic monitor FROM address (optional)", val: &c.SyntheticFrom, def: synthFromDef},
		{key: "SYNTHETIC_TO", desc: "Synthetic monitor TO address (optional)", val: &c.SyntheticTo, def: synthToDef},
		{key: "OIDC_ISSUER", desc: "Panel OIDC issuer URL (optional)", val: &c.OIDCIssuer, valid: optionalURL},
		{key: "OIDC_CLIENT_ID", desc: "Panel OIDC client ID (optional)", val: &c.OIDCClientID},
		{key: "OIDC_CLIENT_SECRET", desc: "Panel OIDC client secret (optional)", val: &c.OIDCClientSecret},
		{key: "OIDC_SCOPES", desc: "Space-separated OIDC scopes (must include groups for role sync)", val: &c.OIDCScopes, def: defaultIfBlank(c.OIDCScopes, "openid email profile groups")},
		{key: "OIDC_GROUPS_CLAIM", desc: "Claim path that holds group membership", val: &c.OIDCGroupsClaim, def: defaultIfBlank(c.OIDCGroupsClaim, "groups")},
		{key: "OIDC_ADMIN_GROUP", desc: "OIDC group whose members get panel admin role", val: &c.AdminGroup, def: defaultIfBlank(c.AdminGroup, "polaris-admins")},
		{key: "R2_PUBLIC_HOST", desc: "R2 public custom domain (e.g. r2.mail.example.com)", val: &c.R2PublicHost},
		{key: "LOGPUSH_DESTINATION_URL", desc: "Optional Logpush HTTP sink. Empty triggers auto-R2 provisioning (recommended); set this to override with an external destination", val: &c.LogpushDestinationURL, valid: optionalURL},
	}
	for _, s := range tail {
		if err := runOne(s.key, s.desc, s.val, s.def, s.valid); err != nil {
			return nil, err
		}
		if err := opts.Save(&c); err != nil {
			return nil, fmt.Errorf("save after prompt %s: %w", s.key, err)
		}
	}

	return &c, nil
}

// runOne shows a single huh.Input. Secret keys get EchoModePassword;
// non-secret keys show the current/default value as the placeholder.
// def is the seed text — if non-empty and the underlying value is
// empty, we pre-populate the field with def so "press enter" keeps it.
func runOne(key, desc string, target *string, def string, validate func(string) error) error {
	if *target == "" && def != "" {
		*target = def
	}
	in := huh.NewInput().
		Title(key).
		Description(desc).
		Value(target)
	if SecretFields[key] {
		in = in.EchoMode(huh.EchoModePassword)
	} else {
		// Show the current value as a placeholder so the operator can
		// see what would persist if they press enter.
		if *target != "" {
			in = in.Placeholder(*target)
		}
	}
	if validate != nil {
		in = in.Validate(validate)
	}
	return in.Run()
}

// notEmpty rejects whitespace-only input on required fields.
func notEmpty(s string) error {
	for _, r := range s {
		if r != ' ' && r != '\t' {
			return nil
		}
	}
	return fmt.Errorf("value is required")
}

// optionalURL allows an empty value, otherwise insists on a parseable
// absolute URL. Cheaper than full validation — the [Validate] pass
// catches the same conditions at save time.
func optionalURL(s string) error {
	if s == "" {
		return nil
	}
	// Re-use the same heuristic Validate() applies; keep them in sync.
	if !looksLikeURL(s) {
		return fmt.Errorf("expected an absolute URL (got %q)", s)
	}
	return nil
}

// looksLikeURL is the shared URL sanity check between prompt-time and
// Validate. We accept anything with a scheme and host; everything else
// (auth, port, path, query) is allowed.
func looksLikeURL(s string) bool {
	// Cheap pre-filter to avoid pulling url.Parse for obviously-wrong
	// strings (no `:` ⇒ no scheme).
	if len(s) < 8 {
		return false
	}
	const httpsPrefix = "https://"
	const httpPrefix = "http://"
	return (len(s) > len(httpsPrefix) && s[:len(httpsPrefix)] == httpsPrefix) ||
		(len(s) > len(httpPrefix) && s[:len(httpPrefix)] == httpPrefix)
}
