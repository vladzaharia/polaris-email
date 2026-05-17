// Package cfapi is a tiny, stdlib-only Cloudflare REST client tailored to
// the resource-creation surface polaris-email needs during cold-start
// (D1, R2, KV, Queues, Workers).
//
// It deliberately avoids the cloudflare-go SDK to keep the polaris-cli
// binary small and free of transitive deps; we only need ~10 endpoints.
//
// Concurrency: a single *Client is safe for concurrent use from multiple
// goroutines. The retry policy is deterministic (no shared mutable
// state).
package cfapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// DefaultBaseURL is the Cloudflare v4 API root.
const DefaultBaseURL = "https://api.cloudflare.com/client/v4"

// Client is a minimal Cloudflare REST client with bearer-token auth and a
// fixed retry policy (3 attempts on 429/5xx with exponential backoff).
type Client struct {
	BaseURL    string
	Token      string
	AccountID  string
	HTTPClient *http.Client
	Logger     *slog.Logger

	// retryBaseDelay is the first-attempt backoff. Tests set it to a tiny
	// duration to avoid sleeping seconds; production keeps the default.
	retryBaseDelay time.Duration
	// retryMaxAttempts is the total number of attempts (including the
	// first). 1 means no retries; default is 3.
	retryMaxAttempts int

	// rand is the source of jitter. nil falls back to time-seeded.
	rand *rand.Rand
}

// Option mutates a *Client after NewClient builds the default.
type Option func(*Client)

// WithBaseURL overrides the API root (useful for tests against
// httptest.NewServer).
func WithBaseURL(u string) Option {
	return func(c *Client) { c.BaseURL = strings.TrimRight(u, "/") }
}

// WithHTTPClient supplies a custom *http.Client. The default carries a
// 30s timeout — overriding lets you bump that for slow-to-create
// resources (D1 cold-start can take ~20s).
func WithHTTPClient(h *http.Client) Option {
	return func(c *Client) { c.HTTPClient = h }
}

// WithLogger attaches an slog.Logger. Without one the client logs to a
// discarded handler.
func WithLogger(l *slog.Logger) Option {
	return func(c *Client) { c.Logger = l }
}

// WithRetryBaseDelay overrides the initial backoff. Primarily for tests
// (set to 1ms so retry-on-429 tests don't hang).
func WithRetryBaseDelay(d time.Duration) Option {
	return func(c *Client) { c.retryBaseDelay = d }
}

// WithRetryAttempts overrides the total attempt count (≥1).
func WithRetryAttempts(n int) Option {
	return func(c *Client) {
		if n < 1 {
			n = 1
		}
		c.retryMaxAttempts = n
	}
}

// NewClient constructs a *Client with sensible defaults. The token must
// be a bearer-style Cloudflare API token (not an X-Auth-Key/Email pair).
func NewClient(token, accountID string, opts ...Option) *Client {
	c := &Client{
		BaseURL:          DefaultBaseURL,
		Token:            token,
		AccountID:        accountID,
		HTTPClient:       &http.Client{Timeout: 30 * time.Second},
		Logger:           slog.New(slog.NewTextHandler(io.Discard, nil)),
		retryBaseDelay:   200 * time.Millisecond,
		retryMaxAttempts: 3,
		rand:             rand.New(rand.NewSource(time.Now().UnixNano())),
	}
	for _, o := range opts {
		o(c)
	}
	return c
}

// cfResponse is the canonical Cloudflare v4 envelope.
type cfResponse struct {
	Success  bool            `json:"success"`
	Errors   []CFErrorEntry  `json:"errors"`
	Messages []CFErrorEntry  `json:"messages"`
	Result   json.RawMessage `json:"result"`
}

// do dispatches a request and decodes the `result` field into out (which
// may be nil). The body is marshalled with json.Marshal unless it is
// already a []byte (in which case it is sent verbatim) or a *bytes.Buffer
// (treated as raw).
//
// Retries: on 429 or 5xx the call is retried up to retryMaxAttempts with
// exponential backoff + jitter. If the response carries a Retry-After
// header (seconds), it is honored for the next sleep. All other 4xx
// statuses fail fast.
func (c *Client) do(ctx context.Context, method, path string, body any, out any) error {
	return c.doWithHeaders(ctx, method, path, nil, body, out)
}

func (c *Client) doWithHeaders(ctx context.Context, method, path string, extraHeaders map[string]string, body any, out any) error {
	var payload []byte
	if body != nil {
		switch b := body.(type) {
		case []byte:
			payload = b
		case *bytes.Buffer:
			payload = b.Bytes()
		case json.RawMessage:
			payload = b
		default:
			var err error
			payload, err = json.Marshal(body)
			if err != nil {
				return fmt.Errorf("cfapi: marshal body: %w", err)
			}
		}
	}

	url := c.BaseURL + path

	var lastErr error
	for attempt := 0; attempt < c.retryMaxAttempts; attempt++ {
		if attempt > 0 {
			delay := c.backoffFor(attempt, lastErr)
			c.Logger.Debug("cfapi retry", "attempt", attempt+1, "delay", delay, "path", path)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(delay):
			}
		}

		req, err := http.NewRequestWithContext(ctx, method, url, bytes.NewReader(payload))
		if err != nil {
			return fmt.Errorf("cfapi: build request: %w", err)
		}
		req.Header.Set("Authorization", "Bearer "+c.Token)
		req.Header.Set("Accept", "application/json")
		if payload != nil && method != http.MethodGet {
			req.Header.Set("Content-Type", "application/json")
		}
		for k, v := range extraHeaders {
			req.Header.Set(k, v)
		}

		resp, err := c.HTTPClient.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("cfapi: %s %s: %w", method, path, err)
			// Network errors are retried.
			continue
		}

		shouldRetry, finalErr, retried := c.handleResponse(resp, out, method, path)
		if retried {
			lastErr = finalErr
			if !shouldRetry {
				return finalErr
			}
			continue
		}
		return finalErr
	}
	if lastErr == nil {
		lastErr = errors.New("cfapi: retries exhausted with no error captured")
	}
	return lastErr
}

// handleResponse reads + decodes resp.
//
// Returns (shouldRetry, err, retried) — `retried=true` signals the caller
// to loop; otherwise the err is final.
func (c *Client) handleResponse(resp *http.Response, out any, method, path string) (bool, error, bool) {
	defer resp.Body.Close()
	rid := resp.Header.Get("X-Cf-Request-Id")
	rawBody, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		return true, fmt.Errorf("cfapi: read body: %w", readErr), true
	}

	// 429 + 5xx → retry-eligible (until attempts exhausted).
	if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
		err := c.decodeError(resp.StatusCode, rawBody, rid)
		c.Logger.Warn("cfapi retryable failure",
			"status", resp.StatusCode, "method", method, "path", path, "cf-request-id", rid)
		// Stash Retry-After on the error for backoffFor to read.
		if ra := resp.Header.Get("Retry-After"); ra != "" {
			if cf, ok := asCloudflareError(err); ok {
				if seconds, perr := strconv.Atoi(ra); perr == nil {
					cf.RequestID = rid
					// Encode retry-after-seconds into the chain; backoffFor
					// extracts it. (Less plumbing than a context value.)
					cf.Chain = append(cf.Chain, CFErrorEntry{Code: -1, Message: "retry-after-seconds=" + strconv.Itoa(seconds)})
				}
			}
		}
		return true, err, true
	}

	if resp.StatusCode >= 400 {
		// Non-retry errors fail fast.
		return false, c.decodeError(resp.StatusCode, rawBody, rid), true
	}

	// 2xx — decode the envelope (CF wraps all results in {success, result, ...}).
	if len(rawBody) == 0 {
		return false, nil, false
	}
	var env cfResponse
	if err := json.Unmarshal(rawBody, &env); err != nil {
		return false, fmt.Errorf("cfapi: decode envelope %s %s (status %d, rid %s): %w",
			method, path, resp.StatusCode, rid, err), false
	}
	if !env.Success {
		return false, &CloudflareError{
			HTTPStatus: resp.StatusCode,
			Code:       firstCode(env.Errors),
			Message:    firstMessage(env.Errors),
			Chain:      env.Errors,
			RequestID:  rid,
		}, false
	}
	if out == nil {
		return false, nil, false
	}
	if len(env.Result) == 0 || string(env.Result) == "null" {
		return false, nil, false
	}
	if err := json.Unmarshal(env.Result, out); err != nil {
		return false, fmt.Errorf("cfapi: decode result %s %s: %w", method, path, err), false
	}
	return false, nil, false
}

// decodeError builds a *CloudflareError from a non-2xx body.
func (c *Client) decodeError(status int, body []byte, rid string) error {
	var env cfResponse
	if jerr := json.Unmarshal(body, &env); jerr == nil && len(env.Errors) > 0 {
		return &CloudflareError{
			HTTPStatus: status,
			Code:       firstCode(env.Errors),
			Message:    firstMessage(env.Errors),
			Chain:      env.Errors,
			RequestID:  rid,
		}
	}
	// Body either was not valid JSON or had no errors[] — surface a
	// best-effort error with the raw text so operators can debug.
	msg := strings.TrimSpace(string(body))
	if len(msg) > 200 {
		msg = msg[:200] + "..."
	}
	return &CloudflareError{
		HTTPStatus: status,
		Message:    msg,
		RequestID:  rid,
	}
}

// backoffFor returns the next sleep duration. If the previous error
// carried a Retry-After-seconds hint, that is preferred; otherwise we
// exponential backoff (200ms, 800ms, 3.2s) with ±25% jitter.
func (c *Client) backoffFor(attempt int, lastErr error) time.Duration {
	if cf, ok := asCloudflareError(lastErr); ok {
		for _, e := range cf.Chain {
			if strings.HasPrefix(e.Message, "retry-after-seconds=") {
				if n, err := strconv.Atoi(strings.TrimPrefix(e.Message, "retry-after-seconds=")); err == nil && n >= 0 {
					return time.Duration(n) * time.Second
				}
			}
		}
	}
	// attempt is 1-indexed for the *next* call (we just finished attempt 0).
	mult := 1
	for i := 1; i < attempt; i++ {
		mult *= 4
	}
	base := c.retryBaseDelay * time.Duration(mult)
	jitter := time.Duration(c.rand.Int63n(int64(base) / 2))
	return base - base/4 + jitter
}

func firstCode(errs []CFErrorEntry) int {
	if len(errs) == 0 {
		return 0
	}
	return errs[0].Code
}

func firstMessage(errs []CFErrorEntry) string {
	if len(errs) == 0 {
		return ""
	}
	return errs[0].Message
}

// accountPath joins the configured AccountID with a per-resource suffix
// (e.g. accountPath("/d1/database") → "/accounts/<acc>/d1/database").
func (c *Client) accountPath(suffix string) string {
	if c.AccountID == "" {
		return suffix
	}
	if !strings.HasPrefix(suffix, "/") {
		suffix = "/" + suffix
	}
	return "/accounts/" + c.AccountID + suffix
}
