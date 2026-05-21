package client

import "time"

// Domain represents a managed email domain.
type Domain struct {
	ID                 string    `json:"id"`
	Name               string    `json:"name"`
	ZoneID             string    `json:"zone_id"`
	Status             string    `json:"status"` // pending|dns_published|verified|active|disabled|failed
	InboundEnabled     bool      `json:"inbound_enabled"`
	OutboundEnabled    bool      `json:"outbound_enabled"`
	WildcardSubdomains bool      `json:"wildcard_subdomains"`
	ParentDomainID     string    `json:"parent_domain_id,omitempty"`
	CreatedAt          time.Time `json:"created_at"`
	UpdatedAt          time.Time `json:"updated_at"`
}

// DomainCreateRequest is the body for POST /v1/admin/domains.
type DomainCreateRequest struct {
	Name               string `json:"name"`
	InboundEnabled     bool   `json:"inbound_enabled"`
	OutboundEnabled    bool   `json:"outbound_enabled"`
	WildcardSubdomains bool   `json:"wildcard_subdomains"`
	Override           bool   `json:"override,omitempty"`
	DKIMAlgo           string `json:"dkim_algo,omitempty"` // ed25519|rsa2048
}

// DomainBulkOnboardRequest is the body for POST /v1/admin/domains/bulk-onboard.
type DomainBulkOnboardRequest struct {
	Pattern            string `json:"pattern"`
	ZoneName           string `json:"zone_name"`
	InboundEnabled     bool   `json:"inbound_enabled"`
	OutboundEnabled    bool   `json:"outbound_enabled"`
	WildcardSubdomains bool   `json:"wildcard_subdomains"`
}

// Zone represents a Cloudflare zone aggregate.
type Zone struct {
	ID        string    `json:"id"`
	CFZoneID  string    `json:"cf_zone_id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
}

// Bridge represents a registered mail bridge.
type Bridge struct {
	ID          string     `json:"id"`
	Name        string     `json:"name"`
	Environment string     `json:"environment"`
	LastSeenAt  *time.Time `json:"last_seen_at,omitempty"`
	DisabledAt  *time.Time `json:"disabled_at,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
}

// BridgeRegisterRequest is the body for POST /v1/admin/bridges.
type BridgeRegisterRequest struct {
	Name        string `json:"name"`
	Environment string `json:"environment"`
}

// BridgeRegisterResponse contains the freshly-minted credentials. The
// HMACSecret and AccessToken are returned exactly once.
type BridgeRegisterResponse struct {
	Bridge       Bridge `json:"bridge"`
	HMACKeyID    string `json:"hmac_key_id"`
	HMACSecret   string `json:"hmac_secret"`
	AccessClient string `json:"access_client_id"`
	AccessToken  string `json:"access_client_secret"`
}

// Route is an inbound routing rule.
type Route struct {
	ID         string    `json:"id"`
	DomainID   string    `json:"domain_id"`
	DomainName string    `json:"domain_name,omitempty"`
	Pattern    string    `json:"pattern"`
	Action     string    `json:"action"` // webhook|forward|drop|alias
	URL        string    `json:"url,omitempty"`
	ForwardTo  string    `json:"forward_to,omitempty"`
	Enabled    bool      `json:"enabled"`
	CreatedAt  time.Time `json:"created_at"`
}

type RouteCreateRequest struct {
	DomainName string `json:"domain_name"`
	Pattern    string `json:"pattern"`
	Action     string `json:"action"`
	URL        string `json:"url,omitempty"`
	ForwardTo  string `json:"forward_to,omitempty"`
	TenantName string `json:"tenant_name,omitempty"`
}

// RoutesApply is the declarative reconciliation payload.
type RoutesApply struct {
	Routes []RouteCreateRequest `json:"routes" yaml:"routes"`
}

// Credential represents an issued API key or SMTP credential.
type Credential struct {
	ID         string     `json:"id"`
	TenantID   string     `json:"tenant_id"`
	TenantName string     `json:"tenant_name,omitempty"`
	Type       string     `json:"type"` // smtp|api
	Username   string     `json:"username,omitempty"`
	Senders    []string   `json:"senders,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
	LastUsedAt *time.Time `json:"last_used_at,omitempty"`
	DisabledAt *time.Time `json:"disabled_at,omitempty"`
}

// CredentialIssueRequest is the body for POST /v1/admin/credentials.
type CredentialIssueRequest struct {
	TenantName    string   `json:"tenant_name"`
	Type          string   `json:"type"`
	Senders       []string `json:"senders"`
	CreateSenders bool     `json:"create_senders,omitempty"`
}

// CredentialIssueResponse returns the plaintext secret exactly once.
type CredentialIssueResponse struct {
	Credential Credential `json:"credential"`
	Secret     string     `json:"secret"`
}

// WebhookDLQEntry is one row of the dead-letter queue.
type WebhookDLQEntry struct {
	ID            string    `json:"id"`
	WebhookSubID  string    `json:"webhook_sub_id"`
	MessageID     string    `json:"message_id"`
	URL           string    `json:"url"`
	AttemptCount  int       `json:"attempt_count"`
	LastError     string    `json:"last_error"`
	LastResponse  int       `json:"last_response_code"`
	FirstFailedAt time.Time `json:"first_failed_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

// WebhookDLQDropRequest carries the destructive-action confirmation.
type WebhookDLQDropRequest struct {
	Confirm string `json:"confirm"` // must equal entry id
}

// LogEntry is a generic activity-log row.
type LogEntry struct {
	Timestamp time.Time         `json:"timestamp"`
	Type      string            `json:"type"` // send|in|webhook|failure
	Domain    string            `json:"domain,omitempty"`
	Tenant    string            `json:"tenant,omitempty"`
	Status    string            `json:"status,omitempty"`
	Subject   string            `json:"subject,omitempty"`
	Message   string            `json:"message,omitempty"`
	Fields    map[string]string `json:"fields,omitempty"`
}

// StatusReport is the response from GET /v1/admin/status.
type StatusReport struct {
	Bridges      []BridgeHealth        `json:"bridges"`
	Domains      []DomainHealth        `json:"domains"`
	ErrorRate1h  float64               `json:"error_rate_1h"`
	ErrorRate24h float64               `json:"error_rate_24h"`
	// Queues is populated only when ?include=queues was requested. The map
	// key is the Workers Queue name (e.g. "polaris-out", "polaris-fanout").
	Queues map[string]QueueDepth `json:"queues,omitempty"`
}

// QueueDepth is one entry in StatusReport.Queues. `DLQ` reports the
// dead-letter queue depth for the same logical queue.
type QueueDepth struct {
	Depth int `json:"depth"`
	DLQ   int `json:"dlq"`
}

type BridgeHealth struct {
	Name      string    `json:"name"`
	Healthy   bool      `json:"healthy"`
	LastSeen  time.Time `json:"last_seen"`
	BuildInfo string    `json:"build_info,omitempty"`
}

type DomainHealth struct {
	Name      string  `json:"name"`
	Status    string  `json:"status"`
	ErrorRate float64 `json:"error_rate"`
}

// AuditChainResult is the response from GET /v1/admin/audit/chain.
type AuditChainResult struct {
	OK             bool      `json:"ok"`
	EntriesWalked  int       `json:"entries_walked"`
	LastSeq        int       `json:"last_seq"`
	LastHash       string    `json:"last_hash"`
	BrokenAtSeq    int       `json:"broken_at_seq,omitempty"`
	WalkedAt       time.Time `json:"walked_at"`
}

// CostReport is the response from GET /v1/admin/cost.
type CostReport struct {
	Month string             `json:"month"` // YYYY-MM
	Total float64            `json:"total_usd"`
	Lines []CostLine         `json:"lines"`
	Meta  map[string]string  `json:"meta,omitempty"`
}

type CostLine struct {
	Service   string  `json:"service"`
	UnitName  string  `json:"unit"`
	UnitCount float64 `json:"unit_count"`
	Cost      float64 `json:"cost_usd"`
}

// ---------------- CF-zone discovery + configure ----------------
//
// These mirror the shapes exported by `packages/cf-api/src/discovery.ts`
// (and the `/v1/admin/cf-zones[...]` endpoints in services/api). The CLI
// consumes them via the SDK helpers in cf_zones.go.

// ZoneSummary is the minimal Cloudflare zone identification triple returned
// by the discovery layer.
type ZoneSummary struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status,omitempty"`
}

// NamedRouteRule represents one named-address Email Routing rule on a zone.
// `RoutesToPolaris` is the inspector's verdict on whether the rule's action
// targets the polaris-mail-in Worker (vs. forwarding mail elsewhere).
type NamedRouteRule struct {
	Name            string `json:"name"`
	Enabled         bool   `json:"enabled"`
	AddressPattern  string `json:"address_pattern,omitempty"`
	ActionType      string `json:"action_type,omitempty"`
	ActionTarget    string `json:"action_target,omitempty"`
	RoutesToPolaris bool   `json:"routes_to_polaris"`
}

// ZoneDomainStatus is the per-zone health report rendered by `cf-zone list`
// and `cf-zone status`. Six checks roll up into `Overall` ("ok"/"warn"/
// "error") server-side.
type ZoneDomainStatus struct {
	Zone                 ZoneSummary      `json:"zone"`
	RoutingEnabled       bool             `json:"routing_enabled"`
	RoutingStatus        string           `json:"routing_status"`
	RoutingStatusOK      bool             `json:"routing_status_ok"`
	DNSRecordsLocked     bool             `json:"dns_records_locked"`
	DNSRecordErrors      []string         `json:"dns_record_errors"`
	SenderOnboarded      bool             `json:"sender_onboarded"`
	SenderMissingRecords []string         `json:"sender_missing_records"`
	CatchAllTarget       *string          `json:"catch_all_target"`
	CatchAllCorrect      bool             `json:"catch_all_correct"`
	NamedRules           []NamedRouteRule `json:"named_rules"`
	HasConflictingRules  bool             `json:"has_conflicting_rules"`
	D1MailDomainExists   bool             `json:"d1_mail_domain_exists"`
	Overall              string           `json:"overall"`
	Error                *string          `json:"error"`
}

// ZoneConfigureOp is one step in the planned configure diff. `Detail` is a
// free-form bag (e.g. the catch-all target name, the auto-publish payload).
type ZoneConfigureOp struct {
	Kind        string         `json:"kind"`
	Description string         `json:"description"`
	Detail      map[string]any `json:"detail,omitempty"`
}

// ZoneConfigureDiff is the planning artefact returned by the dry-run path
// and embedded inside ZoneConfigureResult.
type ZoneConfigureDiff struct {
	Zone     ZoneSummary       `json:"zone"`
	Current  ZoneDomainStatus  `json:"current"`
	Ops      []ZoneConfigureOp `json:"ops"`
	Warnings []string          `json:"warnings"`
}

// ZoneConfigureAppliedFailure is one failed op in an apply response.
type ZoneConfigureAppliedFailure struct {
	Op    ZoneConfigureOp `json:"op"`
	Error string          `json:"error"`
}

// ZoneConfigureApplyResult is the nested `result` on a non-dry-run apply.
type ZoneConfigureApplyResult struct {
	Applied      []ZoneConfigureOp             `json:"applied"`
	Failed       []ZoneConfigureAppliedFailure `json:"failed"`
	AllSucceeded bool                          `json:"all_succeeded"`
}

// ZoneConfigureResult is the full envelope returned by
// POST /v1/admin/cf-zones/:name/configure (both dry-run and apply paths).
type ZoneConfigureResult struct {
	DryRun bool                      `json:"dry_run"`
	Diff   ZoneConfigureDiff         `json:"diff"`
	Result *ZoneConfigureApplyResult `json:"result,omitempty"`
}

// CFZonesListResponse is the envelope returned by GET /v1/admin/cf-zones.
type CFZonesListResponse struct {
	Data      []ZoneDomainStatus `json:"data"`
	FetchedAt string             `json:"fetched_at"`
	Cached    bool               `json:"cached"`
}

// CFZoneGetResponse is the envelope returned by GET /v1/admin/cf-zones/:name.
type CFZoneGetResponse struct {
	Data ZoneDomainStatus `json:"data"`
}
