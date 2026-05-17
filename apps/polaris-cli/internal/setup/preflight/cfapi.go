package preflight

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

// httpDoer abstracts *http.Client for tests.
type httpDoer interface {
	Do(*http.Request) (*http.Response, error)
}

// CFAPIConfig captures the inputs preflight needs to probe a
// Cloudflare API token's scopes.
//
// Token is the bearer token to test. Empty Token → the check is
// skipped (returns a [StatusWarn] like the shell script's "no token
// provided" path).
//
// AccountID is required when Token is set — the list-zones probe filters
// by account scope.
//
// BaseURL defaults to https://api.cloudflare.com/client/v4. Tests
// override this to point at httptest.NewServer.
//
// HTTPClient defaults to a 10s-timeout *http.Client. Tests inject a
// mock implementation here.
type CFAPIConfig struct {
	Token      string
	AccountID  string
	BaseURL    string
	HTTPClient httpDoer
}

// CheckCFAPIToken returns a single composite check covering the three
// shell-side curl probes: Email Routing scope, Zone:Read scope, and a
// `tokens/verify` round-trip to confirm the token isn't revoked.
//
// We deliberately collapse these into one Check (instead of three) to
// match the shell's "best-effort scope check" stanza — multiple probes,
// one operator-visible OK/FAIL line. The Detail captures which sub-probe
// failed when relevant.
func CheckCFAPIToken(cfg CFAPIConfig) Check {
	return Check{
		Name:        "CF_API_TOKEN scopes",
		Required:    false,
		Description: "if CF_API_TOKEN is set, verify it has Email Routing + Zone:Read scopes",
		Run: func(ctx context.Context) Result {
			if cfg.Token == "" {
				return warn("CF_API_TOKEN unset — skipping scope probe",
					"set CF_API_TOKEN in .env.deploy if you plan to run `polaris-email domain onboard --apply`")
			}
			if cfg.AccountID == "" {
				return warn("CF_ACCOUNT_ID unset — cannot run scope probes",
					"set CF_ACCOUNT_ID in .env.deploy")
			}

			base := cfg.BaseURL
			if base == "" {
				base = "https://api.cloudflare.com/client/v4"
			}
			client := cfg.HTTPClient
			if client == nil {
				client = &http.Client{Timeout: 10 * time.Second}
			}

			// 1. tokens/verify — confirms the token is live (200 = green,
			// 401 = revoked/expired). Failure here short-circuits since
			// the scope probes would all return 401 anyway.
			if status, ok := cfGET(ctx, client, base+"/user/tokens/verify", cfg.Token); ok {
				switch status {
				case http.StatusOK:
					// proceed
				case http.StatusUnauthorized:
					return fail("CF_API_TOKEN is invalid or revoked",
						"re-issue the token in the Cloudflare dashboard")
				default:
					return warn(fmt.Sprintf("tokens/verify returned HTTP %d", status), "")
				}
			} else {
				return warn("could not reach Cloudflare API to verify token", "check network connectivity")
			}

			// 2. Email Routing scope probe.
			erURL := fmt.Sprintf("%s/accounts/%s/email/routing/addresses?per_page=1",
				base, url.PathEscape(cfg.AccountID))
			if status, ok := cfGET(ctx, client, erURL, cfg.Token); ok {
				switch status {
				case http.StatusOK, http.StatusNotFound:
					// 200 = scope present + Email Routing enabled.
					// 404 = scope present but routing not enabled — still
					// fine for preflight purposes (routing is enabled per
					// zone during domain onboard).
				case http.StatusForbidden:
					return fail("CF_API_TOKEN lacks Email Routing:Edit",
						"re-issue the token with Email Routing scopes (Read + Edit)")
				default:
					return warn(fmt.Sprintf("Email Routing probe inconclusive (HTTP %d)", status), "")
				}
			} else {
				return warn("Email Routing probe failed (network)", "check network connectivity")
			}

			// 3. Zone:Read across the account.
			zURL := fmt.Sprintf("%s/zones?account.id=%s&per_page=1",
				base, url.QueryEscape(cfg.AccountID))
			if status, ok := cfGET(ctx, client, zURL, cfg.Token); ok {
				switch status {
				case http.StatusOK:
					return pass("Email Routing + Zone:Read scopes verified")
				case http.StatusForbidden:
					return fail("CF_API_TOKEN lacks Zone:Read across the account",
						"re-issue the token including Account-level Zone:Read")
				default:
					return warn(fmt.Sprintf("Zone:Read probe inconclusive (HTTP %d)", status), "")
				}
			}
			return warn("Zone:Read probe failed (network)", "check network connectivity")
		},
	}
}

// cfGET fires a single bearer-authenticated GET. Returns (status, true)
// on a complete HTTP round-trip (including non-2xx). Returns (0, false)
// on transport-level errors (DNS, TLS, timeout).
func cfGET(ctx context.Context, client httpDoer, url, token string) (int, bool) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, false
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return 0, false
	}
	defer resp.Body.Close()
	return resp.StatusCode, true
}
