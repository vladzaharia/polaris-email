// Package config is the typed handle for .env.deploy.
//
// The file on disk stays shell-sourceable (KEY="VALUE" lines, # comments).
// The Go side provides parse + validate + atomic save + huh prompt loop,
// all under unit test.
//
// Adding a new field: add it to the [Config] struct (with the right
// json tag — that's the .env.deploy key), append it to [FieldOrder], and
// add a matching prompt in prompt.go.
package config

// Config is the typed mirror of every field in .env.deploy. The json
// tag is the on-disk variable name; struct field order does NOT
// determine on-disk order — see [FieldOrder] for that.
//
// All fields are strings: .env.deploy is shell-sourceable, so even
// numeric or boolean-looking values are stored as their string form. We
// could parse them at access time but the surface stays smaller this
// way.
//
// String() is intentionally not implemented — these structs are not
// safe to log: CF_API_TOKEN and OIDC_CLIENT_SECRET are secrets.
type Config struct {
	// --- required non-secret fields (preflight enforces) ---

	// CFAccountID is the operator's Cloudflare account ID. Every
	// account-scoped API call hangs off this.
	CFAccountID string `json:"CF_ACCOUNT_ID" yaml:"CF_ACCOUNT_ID"`
	// PolarisAPIHostname is the public hostname services/api serves
	// admin requests at. Defaults to *.workers.dev during cold-start.
	PolarisAPIHostname string `json:"POLARIS_API_HOSTNAME" yaml:"POLARIS_API_HOSTNAME"`

	// --- optional non-secret fields ---

	// CFZoneID is the default zone ID used by `polaris-mail domain
	// onboard --apply` to write DNS records.
	CFZoneID string `json:"CF_ZONE_ID" yaml:"CF_ZONE_ID"`
	// R2PublicHost is the operator-owned custom domain attached to the
	// `polaris-mail` R2 bucket (e.g. r2.mail.example.com).
	R2PublicHost string `json:"R2_PUBLIC_HOST" yaml:"R2_PUBLIC_HOST"`
	// AlertWebhook is the webhook URL that synthetic + staleness alerts
	// POST to on failure.
	AlertWebhook string `json:"ALERT_WEBHOOK" yaml:"ALERT_WEBHOOK"`
	// SyntheticMonitorDomain is the home domain for the synthetic test
	// mailbox; it default-builds the synthetic FROM/TO addresses below.
	SyntheticMonitorDomain string `json:"SYNTHETIC_MONITOR_DOMAIN" yaml:"SYNTHETIC_MONITOR_DOMAIN"`
	// SyntheticFrom is the synthetic monitor's FROM address.
	SyntheticFrom string `json:"SYNTHETIC_FROM" yaml:"SYNTHETIC_FROM"`
	// SyntheticTo is the synthetic monitor's TO address.
	SyntheticTo string `json:"SYNTHETIC_TO" yaml:"SYNTHETIC_TO"`
	// OIDCIssuer is the OIDC discovery URL for the admin panel.
	OIDCIssuer string `json:"OIDC_ISSUER" yaml:"OIDC_ISSUER"`
	// OIDCClientID is the OIDC client ID for the admin panel.
	OIDCClientID string `json:"OIDC_CLIENT_ID" yaml:"OIDC_CLIENT_ID"`
	// OIDCScopes is the space-separated list of scopes the panel requests
	// from the IdP. Must include `groups` (or a provider-specific
	// equivalent) for role sync to work. Defaults to
	// "openid email profile groups" when empty.
	OIDCScopes string `json:"OIDC_SCOPES" yaml:"OIDC_SCOPES"`
	// OIDCGroupsClaim is the JSON path inside the ID token where group
	// membership lives. Most IdPs use `groups`; Okta historically uses
	// `groups`, Auth0 a custom claim, etc. Defaults to "groups".
	OIDCGroupsClaim string `json:"OIDC_GROUPS_CLAIM" yaml:"OIDC_GROUPS_CLAIM"`
	// AdminGroup is the OIDC `groups` claim value that grants panel admin
	// role. Threaded into apps/panel as a `vars.OIDC_ADMIN_GROUP` override
	// at render time. Defaults to "polaris-admins" if empty.
	AdminGroup string `json:"OIDC_ADMIN_GROUP" yaml:"OIDC_ADMIN_GROUP"`
	// LogpushDestinationURL is the optional HTTP sink Workers logs are
	// shipped to. Empty (the default) triggers the auto-R2 provisioning
	// path in setup infra apply: bucket, R2 API token, and Logpush job
	// are all auto-created. Set this to a Better Stack / Honeycomb /
	// Datadog HTTP-sink URL to override and ship to that external
	// destination instead of the auto-created R2 bucket.
	LogpushDestinationURL string `json:"LOGPUSH_DESTINATION_URL" yaml:"LOGPUSH_DESTINATION_URL"`

	// --- secrets ---

	// CFAPIToken is the bearer token `setup infra` uses against the
	// Cloudflare REST API.
	CFAPIToken string `json:"CF_API_TOKEN" yaml:"CF_API_TOKEN"`
	// OIDCClientSecret is the OIDC client secret seeded into the panel
	// Worker via `wrangler secret put` at bootstrap time.
	OIDCClientSecret string `json:"OIDC_CLIENT_SECRET" yaml:"OIDC_CLIENT_SECRET"`
}

// FieldOrder is the canonical order .env.deploy is serialized in.
var FieldOrder = []string{
	"CF_ACCOUNT_ID",
	"POLARIS_API_HOSTNAME",
	"CF_API_TOKEN",
	"CF_ZONE_ID",
	"SYNTHETIC_MONITOR_DOMAIN",
	"ALERT_WEBHOOK",
	"SYNTHETIC_FROM",
	"SYNTHETIC_TO",
	"OIDC_ISSUER",
	"OIDC_CLIENT_ID",
	"OIDC_CLIENT_SECRET",
	"OIDC_SCOPES",
	"OIDC_GROUPS_CLAIM",
	"OIDC_ADMIN_GROUP",
	"R2_PUBLIC_HOST",
	"LOGPUSH_DESTINATION_URL",
}

// SecretFields lists the .env.deploy keys whose values must be hidden
// in TUI prompts and never logged. Centralized so that adding a new
// secret only requires editing one slice.
var SecretFields = map[string]bool{
	"CF_API_TOKEN":       true,
	"OIDC_CLIENT_SECRET": true,
}

// AsMap returns a key=value map of every field, using on-disk variable
// names as keys. Used by both Save() and preflight.CheckEnvDeploy. The
// returned map's iteration order is undefined — use [FieldOrder] when
// rendering.
func (c *Config) AsMap() map[string]string {
	if c == nil {
		return map[string]string{}
	}
	return map[string]string{
		"CF_ACCOUNT_ID":            c.CFAccountID,
		"POLARIS_API_HOSTNAME":     c.PolarisAPIHostname,
		"CF_API_TOKEN":             c.CFAPIToken,
		"CF_ZONE_ID":               c.CFZoneID,
		"SYNTHETIC_MONITOR_DOMAIN": c.SyntheticMonitorDomain,
		"ALERT_WEBHOOK":            c.AlertWebhook,
		"SYNTHETIC_FROM":           c.SyntheticFrom,
		"SYNTHETIC_TO":             c.SyntheticTo,
		"OIDC_ISSUER":              c.OIDCIssuer,
		"OIDC_CLIENT_ID":           c.OIDCClientID,
		"OIDC_CLIENT_SECRET":       c.OIDCClientSecret,
		"OIDC_SCOPES":              c.OIDCScopes,
		"OIDC_GROUPS_CLAIM":        c.OIDCGroupsClaim,
		"OIDC_ADMIN_GROUP":              c.AdminGroup,
		"R2_PUBLIC_HOST":           c.R2PublicHost,
		"LOGPUSH_DESTINATION_URL":  c.LogpushDestinationURL,
	}
}

// setField writes a single key into the typed struct. Returns false if
// the key is unknown — the file loader uses this to decide whether to
// preserve unknown lines (in case the operator hand-edited a field we
// don't yet model).
func (c *Config) setField(key, value string) bool {
	switch key {
	case "CF_ACCOUNT_ID":
		c.CFAccountID = value
	case "POLARIS_API_HOSTNAME":
		c.PolarisAPIHostname = value
	case "CF_API_TOKEN":
		c.CFAPIToken = value
	case "CF_ZONE_ID":
		c.CFZoneID = value
	case "SYNTHETIC_MONITOR_DOMAIN":
		c.SyntheticMonitorDomain = value
	case "ALERT_WEBHOOK":
		c.AlertWebhook = value
	case "SYNTHETIC_FROM":
		c.SyntheticFrom = value
	case "SYNTHETIC_TO":
		c.SyntheticTo = value
	case "OIDC_ISSUER":
		c.OIDCIssuer = value
	case "OIDC_CLIENT_ID":
		c.OIDCClientID = value
	case "OIDC_CLIENT_SECRET":
		c.OIDCClientSecret = value
	case "OIDC_SCOPES":
		c.OIDCScopes = value
	case "OIDC_GROUPS_CLAIM":
		c.OIDCGroupsClaim = value
	case "OIDC_ADMIN_GROUP":
		c.AdminGroup = value
	case "R2_PUBLIC_HOST":
		c.R2PublicHost = value
	case "LOGPUSH_DESTINATION_URL":
		c.LogpushDestinationURL = value
	default:
		return false
	}
	return true
}
