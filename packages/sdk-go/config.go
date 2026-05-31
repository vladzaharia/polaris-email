// Bridge self-fetch: GET /v1/bridge/config.
//
// On startup, the bridge calls this once over its own HMAC-signed
// channel (same pattern as PostBridgeHeartbeat) to pick up the
// operational secrets that drive its embedded ACME loop:
//
//   - CFDnsToken — per-bridge Cloudflare API token scoped to
//     Zone:DNS:Edit + Zone:Read on the mail.plrs.im zone. Used by
//     Lego for the DNS-01 challenge AND by the bridge to maintain
//     its own A record in CF DNS (private/docker-network IP).
//   - CFZone     — the zone name itself; informational.
//   - FQDN       — `<bridge_name>.mail.plrs.im`, the cert SAN.
//   - AcmeEmail  — single service-wide ACME contact address.
//
// The endpoint is HMAC-authed by `bridgeHmacAuth()` on the api side,
// so the same `BridgeID` + `BridgeSecret` already set on the Client
// for /v1/messages submission is what authenticates here.
//
// Errors: the api can return a `key_propagating` 401 when its KV
// plaintext cache for the per-bridge CF token is empty (operator must
// rotate the bridge to repopulate). Callers should retry with backoff
// for a few attempts before failing startup; the typed APIError shape
// from errors.go carries `Code == "key_propagating"` so consumers can
// distinguish from a real auth failure.

package polarissdk

import (
	"context"
	"encoding/json"
	"fmt"
)

// BridgeConfig matches the BridgeConfigResponse Zod schema in
// `packages/schema/src/index.ts`.
type BridgeConfig struct {
	CFDnsToken string `json:"cf_dns_token"`
	CFZone     string `json:"cf_zone"`
	FQDN       string `json:"fqdn"`
	// TailnetFQDN is the bridge's MagicDNS hostname when the api
	// worker has TS_MAGICDNS_DOMAIN configured AND this bridge was
	// minted with a TS auth key. Empty otherwise. The bridge uses it
	// as the first-choice auto-derived webhook URL host (tailnet →
	// FQDN → raw IP, in priority order).
	TailnetFQDN string `json:"tailnet_fqdn"`
	AcmeEmail   string `json:"acme_email"`
	// Per-bridge Tailscale auth key. Empty string when TS minting
	// isn't configured server-side. The bridge's bootstrap-tailscale
	// subcommand reads this and writes it to /run/secrets/ts_authkey
	// so the TS sidecar can pick it up at compose-up time.
	TsAuthkey string `json:"ts_authkey"`
}

// GetBridgeConfig fetches the bridge's operational secrets from the
// control plane. Returns the parsed config or an *APIError carrying
// the canonical code (eg `key_propagating`).
func (c *Client) GetBridgeConfig(ctx context.Context) (*BridgeConfig, error) {
	resp, body, err := c.Do(ctx, "GET", "/v1/bridge/config", "", nil, "", nil)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		return nil, ParseAPIError(resp.StatusCode, body, resp.Header)
	}
	var out BridgeConfig
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("polaris-sdk-go: decode bridge config: %w", err)
	}
	return &out, nil
}
