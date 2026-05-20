// Hand-written HMAC client. The bridge and CLI use this client as the
// auth-aware transport; the typed request/response structs live in
// `messages.go`.
package polarissdk

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Client is an HMAC-signing HTTP client for the polaris-email API surface.
type Client struct {
	BaseURL    string
	HTTPClient *http.Client
	UserAgent  string

	// Auth: pick one — KeyID + KeySecret for the API HMAC, or BridgeID + BridgeSecret
	// for the mail-bridge path. SDK callers can also provide
	// `ExtraHeaders` (e.g. `CF-Access-Client-Id`) baked into every request.
	KeyID        string
	KeySecret    []byte
	BridgeID     string
	BridgeSecret []byte
	ExtraHeaders map[string]string
}

// NewClient constructs a Client with sensible defaults.
func NewClient(baseURL string) *Client {
	return &Client{
		BaseURL:    strings.TrimRight(baseURL, "/"),
		HTTPClient: &http.Client{Timeout: 30 * time.Second},
		UserAgent:  "polaris-sdk-go",
	}
}

// Do signs and executes a request. `query` is the raw query (no leading "?"),
// `body` may be nil. `contentType` defaults to `application/json` for non-nil
// bodies.
func (c *Client) Do(
	ctx context.Context,
	method, path, query string,
	body []byte,
	contentType string,
	extraHeaders map[string]string,
) (*http.Response, []byte, error) {
	if !strings.HasPrefix(path, "/") {
		return nil, nil, fmt.Errorf("polaris-sdk-go: path must start with /")
	}
	ts := NowMillis()
	nonce, err := GenerateNonce()
	if err != nil {
		return nil, nil, err
	}

	target := c.BaseURL + path
	if query != "" {
		target += "?" + strings.TrimPrefix(query, "?")
	}
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, rdr)
	if err != nil {
		return nil, nil, err
	}

	// Pick the auth flavor.
	var secret []byte
	switch {
	case c.KeyID != "" && len(c.KeySecret) > 0:
		req.Header.Set("X-Polaris-Key-Id", c.KeyID)
		secret = c.KeySecret
	case c.BridgeID != "" && len(c.BridgeSecret) > 0:
		req.Header.Set("X-Polaris-Bridge-Id", c.BridgeID)
		secret = c.BridgeSecret
	default:
		return nil, nil, fmt.Errorf("polaris-sdk-go: no credentials configured")
	}

	sig, err := Sign(CanonicalInput{
		Direction: DirectionAPI,
		Method:    method,
		Path:      path,
		Query:     strings.TrimPrefix(query, "?"),
		TS:        ts,
		Nonce:     nonce,
		Body:      body,
	}, secret)
	if err != nil {
		return nil, nil, err
	}

	req.Header.Set("X-Polaris-Ts", ts)
	req.Header.Set("X-Polaris-Nonce", nonce)
	req.Header.Set("X-Polaris-Sig", sig)
	if body != nil {
		if contentType == "" {
			contentType = "application/json"
		}
		req.Header.Set("Content-Type", contentType)
	}
	if c.UserAgent != "" {
		req.Header.Set("User-Agent", c.UserAgent)
	}
	for k, v := range c.ExtraHeaders {
		req.Header.Set(k, v)
	}
	for k, v := range extraHeaders {
		req.Header.Set(k, v)
	}

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	rb, err := io.ReadAll(resp.Body)
	if err != nil {
		return resp, nil, err
	}
	return resp, rb, nil
}
