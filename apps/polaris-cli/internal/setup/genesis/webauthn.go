package genesis

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// pollUntilComplete polls GET /v1/admin/setup/webauthn/<code> every
// PollInterval until either:
//
//   - the server returns status=complete   → (true, nil)
//   - the server returns status=expired    → (false, ErrSetupCodeExpired)
//   - PollTimeout elapses                  → (false, nil)
//   - ctx is cancelled                     → (false, ctx.Err())
//
// On transient HTTP failures the poll loop keeps going (so a network
// blip doesn't abort the seal); only a context cancellation or the
// expired status are escalated.
func pollUntilComplete(
	ctx context.Context,
	httpc *http.Client,
	opts SealOptions,
	setupCode string,
) (bool, error) {
	if setupCode == "" {
		return false, errors.New("genesis: setup code is empty")
	}
	target := strings.TrimRight(opts.APIBaseURL, "/") +
		"/v1/admin/setup/webauthn/" + url.PathEscape(setupCode)

	deadline := time.Now().Add(opts.pollTimeout())
	ticker := time.NewTicker(opts.pollInterval())
	defer ticker.Stop()

	// First poll happens immediately — the operator might have already
	// finished the ceremony by the time the CLI reaches this loop.
	check := func() (status string, transient error) {
		req, err := http.NewRequestWithContext(ctx, "GET", target, nil)
		if err != nil {
			return "", err
		}
		req.Header.Set("User-Agent", "polaris-mail-cli/genesis-seal")
		resp, err := httpc.Do(req)
		if err != nil {
			return "", err
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			return "", err
		}
		if resp.StatusCode != http.StatusOK {
			return "", fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
		}
		var pr pollResponse
		if err := json.Unmarshal(body, &pr); err != nil {
			return "", fmt.Errorf("decode: %w", err)
		}
		return pr.Status, nil
	}

	classify := func(status string) (done, expired bool) {
		switch status {
		case "complete":
			return true, false
		case "expired":
			return true, true
		default:
			return false, false
		}
	}

	if status, err := check(); err == nil {
		done, expired := classify(status)
		if done {
			if expired {
				return false, ErrSetupCodeExpired
			}
			return true, nil
		}
	}
	// Transient failures don't abort the loop — we'll retry on the
	// next tick.

	for {
		select {
		case <-ctx.Done():
			return false, ctx.Err()
		case <-ticker.C:
			if time.Now().After(deadline) {
				return false, nil
			}
			status, err := check()
			if err != nil {
				// Transient — keep going.
				continue
			}
			done, expired := classify(status)
			if done {
				if expired {
					return false, ErrSetupCodeExpired
				}
				return true, nil
			}
		}
	}
}

// ErrSetupCodeExpired is returned when the server reports the setup
// code has expired (5 min server-side TTL). Callers may retry the
// entire seal with a fresh Idempotency-Key — the prior response is
// cached for 24h, so the same admin key is reused.
var ErrSetupCodeExpired = errors.New("genesis: setup code expired before WebAuthn ceremony completed")

// openBrowserDefault picks the right shell-out for the current
// platform. It is intentionally best-effort: we return the underlying
// error so callers can surface it, but no caller treats this as fatal.
func openBrowserDefault(target string) error {
	if target == "" {
		return errors.New("genesis: openBrowser: empty URL")
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", target)
	case "windows":
		// `start ""` lets `start` parse the URL even when it contains
		// `&` (URL query separator).
		cmd = exec.Command("cmd", "/c", "start", "", target)
	default:
		// Linux + the BSDs. Most desktops ship xdg-open.
		cmd = exec.Command("xdg-open", target)
	}
	return cmd.Start()
}
