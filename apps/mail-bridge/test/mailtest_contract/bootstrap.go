//go:build mailtest_contract

package mailtest_contract

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"

	polarissdk "github.com/polaris-mail/polaris-sdk-go"
)

// BootstrapResult is the body the Worker returns from /v1/admin/bootstrap.
type BootstrapResult struct {
	AdminKeyID     string `json:"admin_key_id"`
	AdminKeySecret string `json:"admin_key_secret"`
	OperatorID     string `json:"operator_id"`
	SetupCode      string `json:"setup_code"`
}

// WriteDevVars writes a .dev.vars file at services/api/ so wrangler dev
// picks up POLARIS_SECRET_A (and any other secrets the bootstrap path
// needs). Returns the path written so TestMain can clean it up.
func WriteDevVars(repoRoot string, secretA string) (string, error) {
	path := filepath.Join(repoRoot, "services", "api", ".dev.vars")
	body := fmt.Sprintf("POLARIS_SECRET_A=\"%s\"\n", secretA)
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		return "", err
	}
	return path, nil
}

// BootstrapAdminKey signs the bootstrap POST with POLARIS_SECRET_A and
// returns the minted admin key. Idempotent across calls within a single
// wrangler dev lifetime via the `Idempotency-Key` header — the first
// call seeds, subsequent calls with the same key get the same response.
func BootstrapAdminKey(ctx context.Context, baseURL, secretA, idempotencyKey string) (*BootstrapResult, error) {
	if secretA == "" {
		return nil, errors.New("secretA required")
	}
	bodyBytes := []byte(`{}`)
	ts := polarissdk.NowMillis()
	nonce, err := polarissdk.GenerateNonce()
	if err != nil {
		return nil, err
	}
	sig, err := polarissdk.Sign(polarissdk.CanonicalInput{
		Direction: polarissdk.DirectionAPI,
		Method:    "POST",
		Path:      "/v1/admin/bootstrap",
		Query:     "",
		TS:        ts,
		Nonce:     nonce,
		Body:      bodyBytes,
	}, []byte(secretA))
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", baseURL+"/v1/admin/bootstrap", bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Polaris-Ts", ts)
	req.Header.Set("X-Polaris-Nonce", nonce)
	req.Header.Set("X-Polaris-Sig", sig)
	if idempotencyKey != "" {
		req.Header.Set("Idempotency-Key", idempotencyKey)
	}
	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("bootstrap: status %d: %s", resp.StatusCode, string(rb))
	}
	var out BootstrapResult
	if err := json.Unmarshal(rb, &out); err != nil {
		return nil, fmt.Errorf("bootstrap decode: %w (body=%s)", err, string(rb))
	}
	return &out, nil
}

// RegisterBridgeResult is the response from POST /v1/admin/bridges.
type RegisterBridgeResult struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	HMACKey      string `json:"hmac_key"`
	InstallerURL string `json:"installer_url"`
}

// RegisterBridge calls POST /v1/admin/bridges signed with the admin
// key. `mode=public` skips Tailscale auth-key minting (which would
// fail without TS env vars).
func RegisterBridge(
	ctx context.Context,
	baseURL string,
	adminKeyID, adminKeySecret string,
	name string,
) (*RegisterBridgeResult, error) {
	bodyBytes := []byte(fmt.Sprintf(`{"name":%q,"mode":"public"}`, name))
	ts := polarissdk.NowMillis()
	nonce, err := polarissdk.GenerateNonce()
	if err != nil {
		return nil, err
	}
	sig, err := polarissdk.Sign(polarissdk.CanonicalInput{
		Direction: polarissdk.DirectionAPI,
		Method:    "POST",
		Path:      "/v1/admin/bridges",
		Query:     "",
		TS:        ts,
		Nonce:     nonce,
		Body:      bodyBytes,
	}, []byte(adminKeySecret))
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", baseURL+"/v1/admin/bridges", bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Polaris-Key-Id", adminKeyID)
	req.Header.Set("X-Polaris-Ts", ts)
	req.Header.Set("X-Polaris-Nonce", nonce)
	req.Header.Set("X-Polaris-Sig", sig)
	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("register bridge: status %d: %s", resp.StatusCode, string(rb))
	}
	var out RegisterBridgeResult
	if err := json.Unmarshal(rb, &out); err != nil {
		return nil, fmt.Errorf("register bridge decode: %w (body=%s)", err, string(rb))
	}
	return &out, nil
}

// BridgeTelemetry mirrors the relevant fields from GET /v1/admin/bridges/:id.
type BridgeTelemetry struct {
	ID              string  `json:"id"`
	Name            string  `json:"name"`
	LastSeenAt      *string `json:"last_seen_at"`
	LastHeartbeatAt *string `json:"last_heartbeat_at"`
	BridgeVersion   *string `json:"bridge_version"`
	Liveness        string  `json:"liveness"`
}

// CreateMailboxResult is the response from POST /v1/admin/mailboxes.
type CreateMailboxResult struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// CreateMailbox provisions a new mailbox via POST /v1/admin/mailboxes.
// Needed before IssueAPIKey since send-scoped keys are mailbox-scoped.
func CreateMailbox(
	ctx context.Context,
	baseURL, adminKeyID, adminKeySecret string,
	name string,
) (*CreateMailboxResult, error) {
	body, err := json.Marshal(map[string]any{"name": name})
	if err != nil {
		return nil, err
	}
	ts := polarissdk.NowMillis()
	nonce, err := polarissdk.GenerateNonce()
	if err != nil {
		return nil, err
	}
	sig, err := polarissdk.Sign(polarissdk.CanonicalInput{
		Direction: polarissdk.DirectionAPI,
		Method:    "POST",
		Path:      "/v1/admin/mailboxes",
		Query:     "",
		TS:        ts,
		Nonce:     nonce,
		Body:      body,
	}, []byte(adminKeySecret))
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", baseURL+"/v1/admin/mailboxes", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Polaris-Key-Id", adminKeyID)
	req.Header.Set("X-Polaris-Ts", ts)
	req.Header.Set("X-Polaris-Nonce", nonce)
	req.Header.Set("X-Polaris-Sig", sig)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("create mailbox: status %d: %s", resp.StatusCode, string(rb))
	}
	var out CreateMailboxResult
	if err := json.Unmarshal(rb, &out); err != nil {
		return nil, fmt.Errorf("create mailbox decode: %w (body=%s)", err, string(rb))
	}
	return &out, nil
}

// IssueAPIKeyResult is the response from POST /v1/admin/api-keys.
type IssueAPIKeyResult struct {
	KeyID     string `json:"key_id"`
	KeySecret string `json:"key_secret"`
	Prefix    string `json:"prefix"`
}

// IssueAPIKey mints a service-operator + key with the given scopes via
// POST /v1/admin/api-keys. mailboxID is required because send-scoped
// keys are mailbox-bound. Used by the REST-submission contract test.
func IssueAPIKey(
	ctx context.Context,
	baseURL, adminKeyID, adminKeySecret string,
	mailboxID, displayName string,
	scopes []string,
	rateLimitPerMin int,
) (*IssueAPIKeyResult, error) {
	body, err := json.Marshal(map[string]any{
		"mailbox_id":         mailboxID,
		"display_name":       displayName,
		"scopes":             scopes,
		"rate_limit_per_min": rateLimitPerMin,
	})
	if err != nil {
		return nil, err
	}
	ts := polarissdk.NowMillis()
	nonce, err := polarissdk.GenerateNonce()
	if err != nil {
		return nil, err
	}
	sig, err := polarissdk.Sign(polarissdk.CanonicalInput{
		Direction: polarissdk.DirectionAPI,
		Method:    "POST",
		Path:      "/v1/admin/api-keys",
		Query:     "",
		TS:        ts,
		Nonce:     nonce,
		Body:      body,
	}, []byte(adminKeySecret))
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", baseURL+"/v1/admin/api-keys", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Polaris-Key-Id", adminKeyID)
	req.Header.Set("X-Polaris-Ts", ts)
	req.Header.Set("X-Polaris-Nonce", nonce)
	req.Header.Set("X-Polaris-Sig", sig)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("issue api-key: status %d: %s", resp.StatusCode, string(rb))
	}
	var out IssueAPIKeyResult
	if err := json.Unmarshal(rb, &out); err != nil {
		return nil, fmt.Errorf("issue api-key decode: %w", err)
	}
	return &out, nil
}

// SendJSONMessage POSTs a JSON-form SendRequest to /v1/messages signed
// with the given send-scoped key.
func SendJSONMessage(
	ctx context.Context,
	baseURL, keyID, keySecret string,
	bodyJSON []byte,
) (int, []byte, error) {
	ts := polarissdk.NowMillis()
	nonce, err := polarissdk.GenerateNonce()
	if err != nil {
		return 0, nil, err
	}
	sig, err := polarissdk.Sign(polarissdk.CanonicalInput{
		Direction: polarissdk.DirectionAPI,
		Method:    "POST",
		Path:      "/v1/messages",
		Query:     "",
		TS:        ts,
		Nonce:     nonce,
		Body:      bodyJSON,
	}, []byte(keySecret))
	if err != nil {
		return 0, nil, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", baseURL+"/v1/messages", bytes.NewReader(bodyJSON))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Polaris-Key-Id", keyID)
	req.Header.Set("X-Polaris-Ts", ts)
	req.Header.Set("X-Polaris-Nonce", nonce)
	req.Header.Set("X-Polaris-Sig", sig)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, rb, nil
}

// GetBridgeTelemetry polls GET /v1/admin/bridges/:id for liveness +
// last_heartbeat_at. Used in lieu of the cond-var WaitForHeartbeat
// that the fake provides.
func GetBridgeTelemetry(
	ctx context.Context,
	baseURL, adminKeyID, adminKeySecret, bridgeID string,
) (*BridgeTelemetry, error) {
	path := "/v1/admin/bridges/" + bridgeID
	ts := polarissdk.NowMillis()
	nonce, err := polarissdk.GenerateNonce()
	if err != nil {
		return nil, err
	}
	sig, err := polarissdk.Sign(polarissdk.CanonicalInput{
		Direction: polarissdk.DirectionAPI,
		Method:    "GET",
		Path:      path,
		Query:     "",
		TS:        ts,
		Nonce:     nonce,
		Body:      nil,
	}, []byte(adminKeySecret))
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, "GET", baseURL+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Polaris-Key-Id", adminKeyID)
	req.Header.Set("X-Polaris-Ts", ts)
	req.Header.Set("X-Polaris-Nonce", nonce)
	req.Header.Set("X-Polaris-Sig", sig)
	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("telemetry: status %d: %s", resp.StatusCode, string(rb))
	}
	var out BridgeTelemetry
	if err := json.Unmarshal(rb, &out); err != nil {
		return nil, fmt.Errorf("telemetry decode: %w (body=%s)", err, string(rb))
	}
	return &out, nil
}
