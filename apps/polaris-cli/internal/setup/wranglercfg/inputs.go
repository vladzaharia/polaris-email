// Package wranglercfg renders services/*/wrangler.local.jsonc files
// and merges them with services/*/wrangler.jsonc.
//
// Templates use Go's text/template syntax (`{{ .X.Y }}`) with
// missingkey=error so any undefined reference is a hard failure instead
// of an invisible empty string. The single source of truth for what a
// template can reference is the RenderInputs struct in this file.
//
// JSONC merges go through github.com/tailscale/hujson which preserves
// comments and trailing commas across the parse → merge → emit cycle.
// The previous shell pipeline ran two sed passes over each file to strip
// comments before jq could read them; comments returned in the output
// only by coincidence (jq emitted standard JSON, wrangler accepted both).
// The Go path keeps comments intact end-to-end.
package wranglercfg

import (
	"fmt"
	"strings"
)

// RenderInputs is the typed view of every value a Worker template may
// reference. It is the single source of truth for what `{{ .X.Y }}`
// references resolve to; any new placeholder added to a service template
// MUST also be added here and populated by LoadInputs.
//
// Field naming is deliberately friendly to Go's text/template (PascalCase,
// no acronym lowercasing) so template authors can write
// `{{ .Account.ID }}` and `{{ .Hostnames.PolarisAPI }}` without having
// to remember Go's JSON-tag-style spellings.
type RenderInputs struct {
	Account      AccountInputs
	D1           D1Inputs
	R2           R2Inputs
	KV           KVInputs
	Queues       QueueInputs
	Hostnames    HostnameInputs
	Synthetic    SyntheticInputs
	OIDC         OIDCInputs
	SecretsStore SecretsStoreInputs
	AlertWebhook string
	// LogpushURL is the HTTP sink for the Logpush job (Better Stack,
	// Honeycomb, etc.). Surfaced here so the Terraform module reads it
	// from the same .env.deploy operators already maintain. Workers
	// don't reference it directly.
	LogpushURL string
}

// SecretsStoreInputs surface the optional account-level Secrets Store ID
// the Worker templates conditionally bake into `secrets_store_secrets`.
// Set via POLARIS_SECRETS_STORE_ID in .env.deploy. When empty, the
// templates skip the `secrets_store_secrets` block and the per-Worker
// `wrangler secret put` path is used unchanged.
type SecretsStoreInputs struct {
	StoreID string
}

// AccountInputs holds the Cloudflare account identifier.
type AccountInputs struct {
	ID string
}

// D1Inputs maps the logical D1 database names the templates reference
// onto their concrete IDs. The control-plane is single-DB by design
// (PolarisEmail); the struct is a struct rather than a map so missing
// references explode at template-eval time instead of silently expanding
// to "<no value>".
type D1Inputs struct {
	// PolarisEmail is the single shared D1 database. Mailboxes,
	// messages, audit_log, better-auth tables — all live here.
	PolarisEmail D1Database
}

// D1Database is one D1 instance.
type D1Database struct {
	ID   string
	Name string
}

// R2Inputs is the analogous shape for R2 buckets.
type R2Inputs struct {
	// PolarisEmail is the message-body + attachment bucket fronted by
	// the unauthenticated r2.mail.plrs.im custom domain. SHA-256
	// content addressing is the unguessability boundary.
	PolarisEmail R2Bucket
}

// R2Bucket is one R2 bucket. R2 has no separate ID; buckets are
// addressed by name. Jurisdiction is essential and is plumbed through
// so the operator can see "yes, EU" without grepping the live template.
type R2Bucket struct {
	Name         string
	Jurisdiction string
}

// KVInputs holds the five KV namespaces every Worker references. We
// pull them out as named fields rather than a map so a template typo
// like `{{ .KV.NoNce.ID }}` fails fast with a missingkey error instead
// of silently expanding to empty.
type KVInputs struct {
	Nonce       KVNamespace
	Idempotency KVNamespace
	RateLimit   KVNamespace
	KeyCache    KVNamespace
	Revocations KVNamespace
}

// KVNamespace is one KV namespace.
type KVNamespace struct {
	ID   string
	Name string
}

// QueueInputs is reserved for queue IDs once any template references
// them. Today the queue bindings live in the committed `wrangler.jsonc`
// files (by-name), but if a future template needs the IDs they go here.
type QueueInputs struct {
	Outbound    Queue
	Inbound     Queue
	Fanout      Queue
	OutboundDLQ Queue
	FanoutDLQ   Queue
}

// Queue is one Cloudflare Queue.
type Queue struct {
	ID   string
	Name string
}

// HostnameInputs are the public hostnames the templates bake into vars.
type HostnameInputs struct {
	// PolarisAPI is the public API hostname (e.g. api.mail.plrs.im).
	// Bound to polaris-email-api as a Workers Custom Domain.
	PolarisAPI string
	// Panel is the public admin-UI hostname (e.g. mail.plrs.im).
	// Bound to polaris-email-panel as a Workers Custom Domain.
	Panel string
	// R2Public is the unauthenticated R2 custom domain
	// (e.g. r2.mail.plrs.im). See SECURITY.md.
	R2Public string
}

// SyntheticInputs are the synthetic-monitor-loop config knobs.
type SyntheticInputs struct {
	From           string
	To             string
	MonitorDomain  string
}

// OIDCInputs are the OIDC client config the panel template bakes in.
// The client secret is pushed via `wrangler secret put OIDC_CLIENT_SECRET`,
// not through templates.
//
// Scopes / GroupsClaim / AdminGroup default to sensible values in
// LoadInputs when their .env.deploy counterparts are blank — the panel
// happy path is `openid email profile groups` requested, `groups` claim
// read, `polaris-admins` group elevated.
type OIDCInputs struct {
	Issuer       string
	ClientID     string
	Scopes       string
	GroupsClaim  string
	AdminGroup   string
}

// Validate enforces every required field is populated. The current
// service set requires:
//   - Account.ID + Hostnames.PolarisAPI + Hostnames.Panel (all Workers)
//   - D1.PolarisEmail.ID (api, in, out, panel)
//   - all five KV namespaces (api)
//   - Hostnames.R2Public (api)
//   - OIDC.Issuer + OIDC.ClientID (panel)
//
// AlertWebhook + Synthetic.* fields are optional — the templates
// reference them but the runtime no-ops on empty strings.
func (in *RenderInputs) Validate() error {
	var missing []string
	check := func(name, value string) {
		if strings.TrimSpace(value) == "" {
			missing = append(missing, name)
		}
	}

	check("Account.ID (CF_ACCOUNT_ID)", in.Account.ID)
	check("Hostnames.PolarisAPI (POLARIS_API_HOSTNAME)", in.Hostnames.PolarisAPI)
	check("Hostnames.Panel (POLARIS_PANEL_HOSTNAME)", in.Hostnames.Panel)
	check("Hostnames.R2Public (R2_PUBLIC_HOST)", in.Hostnames.R2Public)

	check("D1.PolarisEmail.ID (state .d1[\"polaris-email\"].id)", in.D1.PolarisEmail.ID)

	check("KV.Nonce.ID (state .kv[\"polaris-email-nonce\"].id)", in.KV.Nonce.ID)
	check("KV.Idempotency.ID (state .kv[\"polaris-email-idempotency\"].id)", in.KV.Idempotency.ID)
	check("KV.RateLimit.ID (state .kv[\"polaris-email-rate-limit\"].id)", in.KV.RateLimit.ID)
	check("KV.KeyCache.ID (state .kv[\"polaris-email-key-cache\"].id)", in.KV.KeyCache.ID)
	check("KV.Revocations.ID (state .kv[\"polaris-email-revocations\"].id)", in.KV.Revocations.ID)

	check("OIDC.Issuer (OIDC_ISSUER)", in.OIDC.Issuer)
	check("OIDC.ClientID (OIDC_CLIENT_ID)", in.OIDC.ClientID)

	if len(missing) == 0 {
		return nil
	}
	return fmt.Errorf(
		"wranglercfg: %d required input(s) missing — rerun `polaris-email setup infra configure` (for env values) or `polaris-email setup infra apply` (for resource IDs):\n  - %s",
		len(missing),
		strings.Join(missing, "\n  - "),
	)
}
