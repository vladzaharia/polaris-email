// Bridge heartbeat v2 — POST /v1/bridge/heartbeat.
//
// The mail-bridge calls this every 60s (adaptive down to 5s; see the
// `NextHeartbeatInSeconds` field on the response). The endpoint is
// HMAC-signed with the per-bridge secret (Client.BridgeID +
// Client.BridgeSecret). Request and response shapes mirror the Zod
// schemas in `packages/schema/src/index.ts` (BridgeHeartbeatRequest +
// BridgeHeartbeatResponse).
//
// Direction summary:
//   request  bridge → api:  telemetry + log delta + directive acks
//   response api → bridge:  enable/disable + settings + new directives
//
// Hard cutover from v1 — SchemaVersion is pinned at 2; the api rejects
// v1 with a 400 "bridge image too old".
package polarissdk

import (
	"context"
	"encoding/json"
	"fmt"
)

// BridgeServiceState mirrors the Zod `BridgeServiceState`.
type BridgeServiceState struct {
	Listening      bool `json:"listening"`
	Port           int  `json:"port"`
	SessionsActive int  `json:"sessions_active"`
	Errors24h      int  `json:"errors_24h"`
}

// BridgeWebhookReceiverState mirrors the inline webhook_receiver shape.
type BridgeWebhookReceiverState struct {
	Deliveries24h int `json:"deliveries_24h"`
	Errors24h     int `json:"errors_24h"`
}

// BridgeNodeInfo mirrors the Zod `BridgeNodeInfo`. *string fields are
// emitted as JSON null when unset.
type BridgeNodeInfo struct {
	Hostname      string  `json:"hostname"`
	OS            string  `json:"os"`
	Arch          string  `json:"arch"`
	ContainerID   *string `json:"container_id"`
	TailnetNodeID *string `json:"tailnet_node_id"`
}

// BridgeAcmeState mirrors the Zod `BridgeAcmeState`.
type BridgeAcmeState struct {
	FQDN                string  `json:"fqdn"`
	CertNotAfter        *string `json:"cert_not_after"`
	LastRenewAttemptAt  *string `json:"last_renew_attempt_at"`
	LastRenewStatus     *string `json:"last_renew_status"` // "ok" | "failed" | "pending"
}

// BridgeMirrorState mirrors the Zod `BridgeMirrorState`.
type BridgeMirrorState struct {
	MessageCount int64   `json:"message_count"`
	LagSeconds   float64 `json:"lag_seconds"`
	LastSyncAt   *string `json:"last_sync_at"`
}

// BridgeErrorRecord mirrors the Zod `BridgeErrorRecord`.
type BridgeErrorRecord struct {
	At      string `json:"at"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// BridgeLogLine mirrors the Zod `BridgeLogLine`. Level is one of
// "debug" | "info" | "warn" | "error".
type BridgeLogLine struct {
	Seq   int64  `json:"seq"`
	At    string `json:"at"`
	Level string `json:"level"`
	Msg   string `json:"msg"`
}

// BridgeDirectiveAck — bridge confirms it applied a server directive.
type BridgeDirectiveAck struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`       // "roll_hmac" | "restart"
	AppliedAt string `json:"applied_at"` // RFC3339
}

// BridgeHeartbeatRequest is the body POSTed to /v1/bridge/heartbeat.
//
// SchemaVersion is mandatory and pinned at 2.
type BridgeHeartbeatRequest struct {
	SchemaVersion   int                  `json:"schema_version"`
	BridgeVersion   string               `json:"bridge_version"`
	UptimeSeconds   int64                `json:"uptime_seconds"`
	ReportedAt      string               `json:"reported_at"`
	Node            BridgeNodeInfo       `json:"node"`
	Services        BridgeServicesBlock  `json:"services"`
	Acme            BridgeAcmeState      `json:"acme"`
	Mirror          BridgeMirrorState    `json:"mirror"`
	RecentErrors    []BridgeErrorRecord  `json:"recent_errors"`
	SettingsVersion int                  `json:"settings_version"`
	DirectiveAcks   []BridgeDirectiveAck `json:"directive_acks"`
	Logs            []BridgeLogLine      `json:"logs"`
	LastLogSeq      int64                `json:"last_log_seq"`
}

// BridgeServicesBlock matches the inline `services` shape in the Zod
// schema. SMTP and IMAP carry per-listener state; WebhookReceiver is a
// lightweight rollup (no port — it lives inside the bridge process).
type BridgeServicesBlock struct {
	SMTP            BridgeServiceState         `json:"smtp"`
	IMAP            BridgeServiceState         `json:"imap"`
	WebhookReceiver BridgeWebhookReceiverState `json:"webhook_receiver"`
}

// BridgeSettings mirrors the Zod `BridgeSettings`. Heartbeat v2.1
// (migration 0013) splits each protocol into its encrypted +
// unencrypted variants — the bridge runs SMTPS + SMTP + IMAPS + IMAP
// listeners independently. `TLSSource` is shared between SMTPS and
// IMAPS (they use the same cert material).
type BridgeSettings struct {
	Version             int    `json:"version"`
	SMTPSEnabled        bool   `json:"smtps_enabled"`
	SMTPSPort           int    `json:"smtps_port"`
	SMTPEnabled         bool   `json:"smtp_enabled"`
	SMTPPort            int    `json:"smtp_port"`
	IMAPSEnabled        bool   `json:"imaps_enabled"`
	IMAPSPort           int    `json:"imaps_port"`
	IMAPEnabled         bool   `json:"imap_enabled"`
	IMAPPort            int    `json:"imap_port"`
	TLSSource           string `json:"tls_source"` // "auto" | "manual"
	MaxMessageSizeBytes int64  `json:"max_message_size_bytes"`
	MaxIMAPSessions     int    `json:"max_imap_sessions"`
	LogLevel            string `json:"log_level"`
	// Inbound-webhook receiver. WebhookEnabled toggles the :8080
	// listener; WebhookURLOverride sets a specific URL polaris will
	// POST events to (empty string = bridge auto-derives, picking
	// the most-specific reachable address: tailnet MagicDNS →
	// <name>.mail.plrs.im → raw IP).
	WebhookEnabled     bool   `json:"webhook_enabled"`
	WebhookURLOverride string `json:"webhook_url_override"`
}

// BridgeDirective is the discriminated union of server-issued one-shot
// commands. Kind is "roll_hmac" or "restart"; the other fields are
// only set for the matching kind. (Go doesn't have native sum types;
// callers switch on Kind.)
type BridgeDirective struct {
	ID             string `json:"id"`
	Kind           string `json:"kind"`
	NewHMACKey     string `json:"new_hmac_key,omitempty"`
	GraceExpiresAt string `json:"grace_expires_at,omitempty"`
	QueuedAt       string `json:"queued_at,omitempty"`
}

// BridgeHeartbeatResponse is what the api returns. Settings is nil when
// the bridge's SettingsVersion matches the server's stored version.
type BridgeHeartbeatResponse struct {
	Enabled                bool              `json:"enabled"`
	Reason                 *string           `json:"reason"`
	NextHeartbeatInSeconds int               `json:"next_heartbeat_in_seconds"`
	Settings               *BridgeSettings   `json:"settings"`
	Directives             []BridgeDirective `json:"directives"`
	LogHighWater           int64             `json:"log_high_water"`
}

// PostBridgeHeartbeat sends one heartbeat + parses the response. The
// caller (heartbeat ticker) applies the directives + settings + enable
// flag to the bridge's supervisor.
func (c *Client) PostBridgeHeartbeat(
	ctx context.Context,
	hb BridgeHeartbeatRequest,
) (*BridgeHeartbeatResponse, error) {
	body, err := json.Marshal(hb)
	if err != nil {
		return nil, fmt.Errorf("polaris-sdk-go: marshal heartbeat: %w", err)
	}
	resp, rb, err := c.Do(ctx, "POST", "/v1/bridge/heartbeat", "", body, "application/json", nil)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		return nil, ParseAPIError(resp.StatusCode, rb, resp.Header)
	}
	var out BridgeHeartbeatResponse
	if err := json.Unmarshal(rb, &out); err != nil {
		return nil, fmt.Errorf("polaris-sdk-go: decode heartbeat response: %w", err)
	}
	return &out, nil
}
