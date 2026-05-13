package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Client is a thin HMAC-signing HTTP client for the polaris-email admin API.
type Client struct {
	BaseURL    string
	KeyID      string
	Secret     []byte
	HTTPClient *http.Client
	UserAgent  string

	// DryRun causes Do/DoJSON to print the request it *would* have made and
	// return a synthetic empty response instead of executing it.
	DryRun     bool
	DryRunSink io.Writer
}

// New constructs a Client.
func New(baseURL, keyID, secret string) *Client {
	return &Client{
		BaseURL:    strings.TrimRight(baseURL, "/"),
		KeyID:      keyID,
		Secret:     []byte(secret),
		HTTPClient: &http.Client{Timeout: 30 * time.Second},
		UserAgent:  "polaris-email-cli",
	}
}

// Request constructs a signed *http.Request without executing it. Useful for
// the SSE log streamer or custom transports.
func (c *Client) Request(ctx context.Context, method, path string, query url.Values, body []byte) (*http.Request, error) {
	if !strings.HasPrefix(path, "/") {
		return nil, fmt.Errorf("client: path must start with /")
	}
	rawQuery := ""
	if query != nil {
		rawQuery = query.Encode()
	}
	ts := NowMillis()
	nonce, err := GenerateNonce()
	if err != nil {
		return nil, err
	}
	sig, err := Sign(CanonicalInput{
		Direction: DirectionAPI,
		Method:    method,
		Path:      path,
		Query:     rawQuery,
		TS:        ts,
		Nonce:     nonce,
		Body:      body,
	}, c.Secret)
	if err != nil {
		return nil, err
	}

	target := c.BaseURL + path
	if rawQuery != "" {
		target += "?" + rawQuery
	}
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, rdr)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Polaris-Ts", ts)
	req.Header.Set("X-Polaris-Nonce", nonce)
	req.Header.Set("X-Polaris-Sig", sig)
	if c.KeyID != "" {
		req.Header.Set("X-Polaris-Key-Id", c.KeyID)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.UserAgent != "" {
		req.Header.Set("User-Agent", c.UserAgent)
	}
	return req, nil
}

// Do executes the request and returns the raw response body. On non-2xx the
// returned error includes the status line and body.
func (c *Client) Do(ctx context.Context, method, path string, query url.Values, body []byte) ([]byte, error) {
	req, err := c.Request(ctx, method, path, query, body)
	if err != nil {
		return nil, err
	}
	if c.DryRun {
		printDryRun(c.DryRunSink, req, body)
		return []byte("{}"), nil
	}
	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	rb, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 300 {
		return nil, &HTTPError{Status: resp.StatusCode, Body: string(rb), Method: method, Path: path}
	}
	return rb, nil
}

// DoJSON wraps Do with JSON encoding/decoding.
func (c *Client) DoJSON(ctx context.Context, method, path string, query url.Values, body, out any) error {
	var raw []byte
	if body != nil {
		var err error
		raw, err = json.Marshal(body)
		if err != nil {
			return err
		}
	}
	resp, err := c.Do(ctx, method, path, query, raw)
	if err != nil {
		return err
	}
	if out == nil || c.DryRun {
		return nil
	}
	if len(resp) == 0 {
		return nil
	}
	return json.Unmarshal(resp, out)
}

// HTTPError is returned for non-2xx responses.
type HTTPError struct {
	Status int
	Body   string
	Method string
	Path   string
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("polaris-email API %s %s: HTTP %d: %s", e.Method, e.Path, e.Status, strings.TrimSpace(e.Body))
}

func printDryRun(w io.Writer, req *http.Request, body []byte) {
	if w == nil {
		return
	}
	fmt.Fprintf(w, "DRY-RUN %s %s\n", req.Method, req.URL.String())
	for k, v := range req.Header {
		// Mask the signature so dry-run logs are paste-safe.
		if strings.EqualFold(k, "X-Polaris-Sig") {
			fmt.Fprintf(w, "  %s: <redacted>\n", k)
			continue
		}
		fmt.Fprintf(w, "  %s: %s\n", k, strings.Join(v, ", "))
	}
	if len(body) > 0 {
		fmt.Fprintf(w, "  body: %s\n", string(body))
	}
}
