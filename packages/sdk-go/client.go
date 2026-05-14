// Hand-written HMAC client. The generated low-level operations (when codegen
// runs) live in `generated.go`; the daemon and CLI use this client as the
// auth-aware transport.
package polarissdk

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Client is an HMAC-signing HTTP client for the polaris-email API surface.
type Client struct {
	BaseURL    string
	HTTPClient *http.Client
	UserAgent  string

	// Auth: pick one — KeyID + KeySecret for tenant HMAC, or DaemonID + DaemonSecret
	// for the submission-daemon path. SDK callers can also provide
	// `ExtraHeaders` (e.g. `CF-Access-Client-Id`) baked into every request.
	KeyID        string
	KeySecret    []byte
	DaemonID     string
	DaemonSecret []byte
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
	ts := strconv.FormatInt(time.Now().UnixMilli(), 10)
	nonce, err := generateNonce()
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
	case c.DaemonID != "" && len(c.DaemonSecret) > 0:
		req.Header.Set("X-Polaris-Daemon-Id", c.DaemonID)
		secret = c.DaemonSecret
	default:
		return nil, nil, fmt.Errorf("polaris-sdk-go: no credentials configured")
	}

	canonical := strings.Join([]string{
		string(DirectionAPI),
		strings.ToUpper(method),
		path,
		canonicalQuery(query),
		ts,
		nonce,
		sha256Hex(body),
	}, "\n")
	sig := "v1=" + hmacHex(secret, []byte(canonical))

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

func generateNonce() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	// Crockford base32 — matches packages/hmac/src/index.ts.
	const alpha = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
	var bits, acc uint32
	var sb strings.Builder
	for _, by := range b {
		acc = (acc << 8) | uint32(by)
		bits += 8
		for bits >= 5 {
			bits -= 5
			sb.WriteByte(alpha[(acc>>bits)&31])
		}
	}
	if bits > 0 {
		sb.WriteByte(alpha[(acc<<(5-bits))&31])
	}
	return sb.String(), nil
}

func sha256Hex(b []byte) string {
	h := sha256SumOrEmpty(b)
	return hex.EncodeToString(h[:])
}
