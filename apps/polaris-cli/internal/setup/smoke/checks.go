// Package smoke runs three end-to-end checks against a deployed
// polaris-mail stack:
//
//  1. GET /healthz → 200 (anonymous, no signing).
//  2. Signed GET /v1/admin/status → mailbox + domain counts non-nil.
//  3. Synthetic outbound: POST /v1/messages, poll /v1/messages/<id>
//     up to 60s for status=delivered.
//
// Each check is independently runnable so the cmd leaf can render a
// live table (one row per check) under the Bubble Tea reporter.
package smoke

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
)

// Result captures the outcome of one check.
type Result struct {
	// Name is a short label for tables / logs ("healthz",
	// "admin-status", "synthetic-outbound").
	Name string
	// Status is one of "pass" | "fail" | "skip".
	Status string
	// Detail is a human-readable explanation. On failure this is the
	// error message; on pass it's a short success blurb.
	Detail string
	// Duration is the wall-clock time the check took.
	Duration time.Duration
}

// Config carries the inputs every check needs. APIClient is optional
// for healthz but required for the signed checks.
type Config struct {
	// APIBaseURL is the public base URL, e.g.
	// "https://polaris-mail-api.example.com". Required.
	APIBaseURL string
	// APIClient is a signed-request client (see internal/client). nil
	// disables the admin-status + synthetic checks.
	APIClient *client.Client
	// SyntheticFrom, SyntheticTo gate the synthetic-outbound check.
	// Empty values cause that check to skip cleanly.
	SyntheticFrom string
	SyntheticTo   string
	// PollInterval defaults to 5 seconds; PollTimeout defaults to 60s.
	PollInterval time.Duration
	PollTimeout  time.Duration
	// HTTPClient overrides the default http.Client. nil → 10s timeout.
	HTTPClient *http.Client
	// SkipSynthetic forces the synthetic-outbound check to skip even
	// when the from/to addresses are populated.
	SkipSynthetic bool
}

// httpClient resolves to a sensible default when Config.HTTPClient is
// nil.
func (c Config) httpClient() *http.Client {
	if c.HTTPClient != nil {
		return c.HTTPClient
	}
	return &http.Client{Timeout: 10 * time.Second}
}

// pollInterval returns 5s when unset.
func (c Config) pollInterval() time.Duration {
	if c.PollInterval > 0 {
		return c.PollInterval
	}
	return 5 * time.Second
}

// pollTimeout returns 60s when unset.
func (c Config) pollTimeout() time.Duration {
	if c.PollTimeout > 0 {
		return c.PollTimeout
	}
	return 60 * time.Second
}

// CheckHealthz runs the anonymous GET /healthz check.
func CheckHealthz(ctx context.Context, cfg Config) Result {
	start := time.Now()
	r := Result{Name: "healthz"}
	if cfg.APIBaseURL == "" {
		r.Status = "fail"
		r.Detail = "APIBaseURL is empty"
		r.Duration = time.Since(start)
		return r
	}
	url := strings.TrimRight(cfg.APIBaseURL, "/") + "/healthz"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		r.Status = "fail"
		r.Detail = err.Error()
		r.Duration = time.Since(start)
		return r
	}
	resp, err := cfg.httpClient().Do(req)
	if err != nil {
		r.Status = "fail"
		r.Detail = err.Error()
		r.Duration = time.Since(start)
		return r
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		r.Status = "fail"
		r.Detail = fmt.Sprintf("HTTP %d", resp.StatusCode)
		r.Duration = time.Since(start)
		return r
	}
	r.Status = "pass"
	r.Detail = "200 OK"
	r.Duration = time.Since(start)
	return r
}

// CheckAdminStatus runs the signed GET /v1/admin/status check. Asserts
// `mailboxes` and `domains` keys both exist in the response.
func CheckAdminStatus(ctx context.Context, cfg Config) Result {
	start := time.Now()
	r := Result{Name: "admin-status"}
	if cfg.APIClient == nil {
		r.Status = "skip"
		r.Detail = "no API client wired (missing bootstrap output)"
		r.Duration = time.Since(start)
		return r
	}
	body, err := cfg.APIClient.Do(ctx, http.MethodGet, "/v1/admin/status", nil, nil)
	if err != nil {
		r.Status = "fail"
		r.Detail = err.Error()
		r.Duration = time.Since(start)
		return r
	}
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		r.Status = "fail"
		r.Detail = fmt.Sprintf("decode: %v", err)
		r.Duration = time.Since(start)
		return r
	}
	if _, ok := raw["mailboxes"]; !ok {
		r.Status = "fail"
		r.Detail = "response missing `mailboxes`"
		r.Duration = time.Since(start)
		return r
	}
	if _, ok := raw["domains"]; !ok {
		r.Status = "fail"
		r.Detail = "response missing `domains`"
		r.Duration = time.Since(start)
		return r
	}
	r.Status = "pass"
	r.Detail = "mailboxes + domains present"
	r.Duration = time.Since(start)
	return r
}

// CheckSyntheticOutbound runs the round-trip outbound test. Posts a
// minimal message to /v1/messages, then polls
// /v1/messages/<message_id> until status=delivered (pass) or
// status=bounced|failed (fail) or PollTimeout elapses (fail).
func CheckSyntheticOutbound(ctx context.Context, cfg Config) Result {
	start := time.Now()
	r := Result{Name: "synthetic-outbound"}
	if cfg.SkipSynthetic {
		r.Status = "skip"
		r.Detail = "skipped via --skip-synthetic"
		r.Duration = time.Since(start)
		return r
	}
	if cfg.APIClient == nil {
		r.Status = "skip"
		r.Detail = "no API client wired"
		r.Duration = time.Since(start)
		return r
	}
	if cfg.SyntheticFrom == "" || cfg.SyntheticTo == "" {
		r.Status = "skip"
		r.Detail = "SyntheticFrom/SyntheticTo unset"
		r.Duration = time.Since(start)
		return r
	}

	idempotency := fmt.Sprintf("smoke-%d", time.Now().UnixNano())
	body := map[string]any{
		"from":             cfg.SyntheticFrom,
		"to":               []string{cfg.SyntheticTo},
		"subject":          "polaris smoke",
		"text":             "smoke",
		"idempotency_key":  idempotency,
	}
	var enqueueResp struct {
		MessageID string `json:"message_id"`
	}
	if err := cfg.APIClient.DoJSON(ctx, http.MethodPost, "/v1/messages", nil, body, &enqueueResp); err != nil {
		r.Status = "fail"
		r.Detail = fmt.Sprintf("enqueue: %v", err)
		r.Duration = time.Since(start)
		return r
	}
	if enqueueResp.MessageID == "" {
		r.Status = "fail"
		r.Detail = "enqueue response missing message_id"
		r.Duration = time.Since(start)
		return r
	}

	deadline := time.Now().Add(cfg.pollTimeout())
	interval := cfg.pollInterval()
	mid := enqueueResp.MessageID
	statusPath := "/v1/messages/" + mid

	for time.Now().Before(deadline) {
		if err := sleepCtx(ctx, interval); err != nil {
			r.Status = "fail"
			r.Detail = err.Error()
			r.Duration = time.Since(start)
			return r
		}
		var statusResp struct {
			Status string `json:"status"`
		}
		if err := cfg.APIClient.DoJSON(ctx, http.MethodGet, statusPath, nil, nil, &statusResp); err != nil {
			// Transient errors during polling shouldn't fail the
			// check immediately — continue and let the deadline catch
			// a true outage.
			continue
		}
		switch statusResp.Status {
		case "delivered":
			r.Status = "pass"
			r.Detail = fmt.Sprintf("delivered (id=%s) in %s", mid, time.Since(start).Round(time.Second))
			r.Duration = time.Since(start)
			return r
		case "bounced", "failed":
			r.Status = "fail"
			r.Detail = fmt.Sprintf("status=%s (id=%s)", statusResp.Status, mid)
			r.Duration = time.Since(start)
			return r
		}
	}
	r.Status = "fail"
	r.Detail = fmt.Sprintf("not delivered within %s (id=%s)", cfg.pollTimeout(), mid)
	r.Duration = time.Since(start)
	return r
}

// sleepCtx sleeps for d unless ctx fires first.
func sleepCtx(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// RunAll runs all three checks in sequence and returns the slice.
// Order: healthz → admin-status → synthetic-outbound.
func RunAll(ctx context.Context, cfg Config) []Result {
	return []Result{
		CheckHealthz(ctx, cfg),
		CheckAdminStatus(ctx, cfg),
		CheckSyntheticOutbound(ctx, cfg),
	}
}

// AnyFailed reports whether any check has Status="fail".
func AnyFailed(results []Result) bool {
	for _, r := range results {
		if r.Status == "fail" {
			return true
		}
	}
	return false
}

// ErrNoFailures is returned when AnyFailed returns false but a caller
// asked for a non-nil error mapping. Exported so the cmd leaf can
// distinguish "no checks ran" from "checks ran cleanly".
var ErrNoFailures = errors.New("smoke: no failures")
