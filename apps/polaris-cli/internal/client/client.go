// Package client wraps polaris-sdk-go for the polaris-mail admin CLI.
//
// The CLI used to carry its own copy of the HMAC scheme (see the deleted
// `internal/client/hmac.go`). After cleanup the canonical helpers
// live in `github.com/polaris-mail/polaris-sdk-go`; this package just wraps
// the SDK with the CLI's HTTP transport + dry-run sink.
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

	polarissdk "github.com/polaris-mail/polaris-sdk-go"
)

// Client is a thin HMAC-signing HTTP client for the polaris-mail admin API.
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
		UserAgent:  "polaris-mail-cli",
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
	ts := polarissdk.NowMillis()
	nonce, err := polarissdk.GenerateNonce()
	if err != nil {
		return nil, err
	}
	sig, err := polarissdk.Sign(polarissdk.CanonicalInput{
		Direction: polarissdk.DirectionAPI,
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
//
// The HTTP call routes through polaris-sdk-go's Client to keep the canonical
// signing logic in one place. The dry-run path still goes through the local
// Request() helper so the printed request is byte-identical to what would be
// sent.
func (c *Client) Do(ctx context.Context, method, path string, query url.Values, body []byte) ([]byte, error) {
	if c.DryRun {
		req, err := c.Request(ctx, method, path, query, body)
		if err != nil {
			return nil, err
		}
		printDryRun(c.DryRunSink, req, body)
		return []byte("{}"), nil
	}
	rawQuery := ""
	if query != nil {
		rawQuery = query.Encode()
	}
	sdk := polarissdk.NewClient(c.BaseURL)
	if c.HTTPClient != nil {
		sdk.HTTPClient = c.HTTPClient
	}
	sdk.UserAgent = c.UserAgent
	sdk.KeyID = c.KeyID
	sdk.KeySecret = c.Secret
	resp, rb, err := sdk.Do(ctx, method, path, rawQuery, body, "", nil)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 300 {
		return nil, &HTTPError{
			Status:    resp.StatusCode,
			Body:      string(rb),
			Method:    method,
			Path:      path,
			RequestID: resp.Header.Get("X-Request-Id"),
		}
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

// HTTPError is returned for non-2xx responses. RequestID echoes the
// server's X-Request-Id header so operators can correlate failures back
// to service logs.
type HTTPError struct {
	Status    int
	Body      string
	Method    string
	Path      string
	RequestID string
}

func (e *HTTPError) Error() string {
	suffix := ""
	if e.RequestID != "" {
		suffix = " (request-id: " + e.RequestID + ")"
	}
	return fmt.Sprintf(
		"polaris-mail API %s %s: HTTP %d: %s%s",
		e.Method, e.Path, e.Status, strings.TrimSpace(e.Body), suffix,
	)
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
