// Bridge heartbeat — POST /v1/bridge/heartbeat.
//
// The mail-bridge calls this every ~60s with a small snapshot of
// in-process counters. The endpoint is HMAC-signed with the per-bridge
// secret (Client.BridgeID + Client.BridgeSecret), not an admin api key.
//
// Body matches the Zod `BridgeHeartbeatBody` schema in
// `packages/schema/src/index.ts`. Keep the field names + schema_version
// in lockstep across the two sides; the server rejects shapes it can't
// parse with HTTP 400.
package polarissdk

import (
	"context"
	"encoding/json"
	"fmt"
)

// BridgeHeartbeat is the body posted to POST /v1/bridge/heartbeat.
//
// SchemaVersion is mandatory and pinned at 1; bump it (and add a new
// handler branch on the server) before changing field semantics.
type BridgeHeartbeat struct {
	SchemaVersion       int    `json:"schema_version"`
	BridgeVersion       string `json:"bridge_version"`
	UptimeSeconds       int64  `json:"uptime_seconds"`
	IMAPSessionsActive  int    `json:"imap_sessions_active"`
	SMTPSubmissions24h  int    `json:"smtp_submissions_24h"`
	Errors24h           int    `json:"errors_24h"`
	MirrorMessageCount  int    `json:"mirror_message_count"`
	ReportedAt          string `json:"reported_at"`
}

// PostBridgeHeartbeat sends one heartbeat. Returns nil on 204; any non-2xx
// is surfaced as a *APIError (same convention as the rest of the SDK).
func (c *Client) PostBridgeHeartbeat(ctx context.Context, hb BridgeHeartbeat) error {
	body, err := json.Marshal(hb)
	if err != nil {
		return fmt.Errorf("polaris-sdk-go: marshal heartbeat: %w", err)
	}
	resp, rb, err := c.Do(ctx, "POST", "/v1/bridge/heartbeat", "", body, "application/json", nil)
	if err != nil {
		return err
	}
	if resp.StatusCode >= 400 {
		return ParseAPIError(resp.StatusCode, rb, resp.Header)
	}
	return nil
}
