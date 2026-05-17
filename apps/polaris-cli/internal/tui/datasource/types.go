// TUI-only response types. Mirror the actual /v1/admin/* JSON shapes
// without depending on existing types in `internal/client` that may have
// drifted (the legacy `StatusReport` doesn't match what /v1/admin/status
// actually returns, for example).
package datasource

import "time"

// AdminStatusCounts is the response of GET /v1/admin/status.
type AdminStatusCounts struct {
	Mailboxes       int `json:"mailboxes"`
	Domains         int `json:"domains"`
	Bridges         int `json:"bridges"`
	APIKeys         int `json:"api_keys"`
	MessagesLast24h int `json:"messages_last_24h"`
	WebhookDLQDepth int `json:"webhook_dlq_depth"`
}

// StatsOverview is the response of GET /v1/admin/stats/overview.
type StatsOverview struct {
	Window      string `json:"window"`
	Cardinality struct {
		Mailboxes          int `json:"mailboxes"`
		DomainsVerified    int `json:"domains_verified"`
		DomainsPending     int `json:"domains_pending"`
		DomainsFailed      int `json:"domains_failed"`
		Senders            int `json:"senders"`
		CredentialsAPIKey  int `json:"credentials_api_key"`
		CredentialsSMTP    int `json:"credentials_smtp"`
		WebhookSubs        int `json:"webhook_subs"`
	} `json:"cardinality"`
	Messages struct {
		Sent             int `json:"sent"`
		Delivered        int `json:"delivered"`
		Failed           int `json:"failed"`
		Bounced          int `json:"bounced"`
		InboundReceived  int `json:"inbound_received"`
	} `json:"messages"`
	DLQDepth int `json:"dlq_depth"`
}

// AuditChainStatus is GET /v1/admin/audit/chain-status.
type AuditChainStatus struct {
	Head struct {
		ID      int    `json:"id"`
		RowHash string `json:"row_hash"`
		At      int64  `json:"at"`
	} `json:"head"`
	LatestAnchor *struct {
		ID           int    `json:"id"`
		LastAuditID  int    `json:"last_audit_id"`
		LastRowHash  string `json:"last_row_hash"`
		Signature    string `json:"signature"`
		SignedAt     int64  `json:"signed_at"`
		ExternalRef  string `json:"external_ref"`
	} `json:"latest_anchor,omitempty"`
}

// AnchorRow is one row from GET /v1/admin/audit/anchors.
type AnchorRow struct {
	ID           int       `json:"id"`
	LastAuditID  int       `json:"last_audit_id"`
	Signature    string    `json:"signature"`
	SignedAt     time.Time `json:"signed_at"`
	ExternalRef  string    `json:"external_ref,omitempty"`
}

// AuditEntry is one row from GET /v1/admin/audit/chain.
type AuditEntry struct {
	ID     int       `json:"id"`
	Actor  string    `json:"actor"`
	Action string    `json:"action"`
	Target string    `json:"target,omitempty"`
	At     time.Time `json:"at"`
}

// Mailbox is the row from /v1/admin/mailboxes (subset).
type Mailbox struct {
	ID          string     `json:"id"`
	Name        string     `json:"name"`
	Description string     `json:"description,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
	DisabledAt  *time.Time `json:"disabled_at,omitempty"`
}

// Credential row (unified facade for api_keys + smtp_credentials).
type Credential struct {
	Kind        string     `json:"kind"`
	ID          string     `json:"id"`
	PrincipalID string     `json:"principal_id"`
	Status      string     `json:"status"`
	Username    string     `json:"username,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	DisabledAt  *time.Time `json:"disabled_at,omitempty"`
}

// CredStats is GET /v1/admin/credentials/:id/stats.
type CredStats struct {
	CredentialID string `json:"credential_id"`
	Window       string `json:"window"`
	Counts       struct {
		Sent      int `json:"sent"`
		Delivered int `json:"delivered"`
		Failed    int `json:"failed"`
		Bounced   int `json:"bounced"`
	} `json:"counts"`
}

// WebhookSub is the row from /v1/admin/webhook-subs.
type WebhookSub struct {
	ID         string     `json:"id"`
	MailboxID  string     `json:"mailbox_id"`
	URL        string     `json:"url"`
	Kind       string     `json:"kind"`
	Events     []string   `json:"events"`
	PausedAt   *time.Time `json:"paused_at,omitempty"`
	DisabledAt *time.Time `json:"disabled_at,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
}

// Alert is a row from /v1/admin/alerts.
type Alert struct {
	ID        string    `json:"id"`
	Severity  string    `json:"severity"`
	Type      string    `json:"type"`
	Message   string    `json:"message"`
	CreatedAt time.Time `json:"created_at"`
}
