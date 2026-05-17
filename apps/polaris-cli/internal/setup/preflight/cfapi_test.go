package preflight

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeCFAPIServer returns an httptest.Server that emulates Cloudflare's
// REST surface for the three preflight probes (tokens/verify, email
// routing addresses, zones list).
//
// Behavior:
//   - tokens/verify   → 200 unless the token equals "expired" (then 401)
//   - email routing   → 403 if token is "no-er", else 200
//   - zones           → 403 if token is "no-zone", else 200
//
// This setup lets us cover the happy path, the two distinct scope-fail
// paths, and the revoked-token short-circuit with a single fixture.
func fakeCFAPIServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		path := r.URL.Path
		switch {
		case strings.HasSuffix(path, "/user/tokens/verify"):
			if tok == "expired" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"success":true,"result":{}}`))
		case strings.Contains(path, "/email/routing/addresses"):
			if tok == "no-er" {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"success":true,"result":[]}`))
		case strings.Contains(path, "/zones"):
			if tok == "no-zone" {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"success":true,"result":[]}`))
		default:
			t.Logf("unexpected request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestCheckCFAPIToken_NoTokenSkips(t *testing.T) {
	t.Parallel()
	c := CheckCFAPIToken(CFAPIConfig{}) // no token
	res := c.Run(context.Background())
	if res.Status != StatusWarn {
		t.Errorf("no token should warn, got %+v", res)
	}
}

func TestCheckCFAPIToken_HappyPath(t *testing.T) {
	t.Parallel()
	srv := fakeCFAPIServer(t)
	c := CheckCFAPIToken(CFAPIConfig{
		Token:     "good",
		AccountID: "acc-123",
		BaseURL:   srv.URL,
	})
	res := c.Run(context.Background())
	if res.Status != StatusPass {
		t.Errorf("happy path should pass, got %+v", res)
	}
}

func TestCheckCFAPIToken_RevokedToken(t *testing.T) {
	t.Parallel()
	srv := fakeCFAPIServer(t)
	c := CheckCFAPIToken(CFAPIConfig{
		Token:     "expired",
		AccountID: "acc-123",
		BaseURL:   srv.URL,
	})
	res := c.Run(context.Background())
	if res.Status != StatusFail {
		t.Errorf("expired token should fail, got %+v", res)
	}
	if !strings.Contains(res.Detail, "invalid") {
		t.Errorf("Detail should mention the token: %q", res.Detail)
	}
}

func TestCheckCFAPIToken_MissingEmailRoutingScope(t *testing.T) {
	t.Parallel()
	srv := fakeCFAPIServer(t)
	c := CheckCFAPIToken(CFAPIConfig{
		Token:     "no-er",
		AccountID: "acc-123",
		BaseURL:   srv.URL,
	})
	res := c.Run(context.Background())
	if res.Status != StatusFail {
		t.Errorf("missing-ER-scope should fail, got %+v", res)
	}
	if !strings.Contains(res.Detail, "Email Routing") {
		t.Errorf("Detail should name Email Routing: %q", res.Detail)
	}
}

func TestCheckCFAPIToken_MissingZoneScope(t *testing.T) {
	t.Parallel()
	srv := fakeCFAPIServer(t)
	c := CheckCFAPIToken(CFAPIConfig{
		Token:     "no-zone",
		AccountID: "acc-123",
		BaseURL:   srv.URL,
	})
	res := c.Run(context.Background())
	if res.Status != StatusFail {
		t.Errorf("missing-zone-scope should fail, got %+v", res)
	}
	if !strings.Contains(res.Detail, "Zone") {
		t.Errorf("Detail should name Zone:Read: %q", res.Detail)
	}
}

func TestCheckCFAPIToken_NoAccountIDWarns(t *testing.T) {
	t.Parallel()
	c := CheckCFAPIToken(CFAPIConfig{Token: "any-token"})
	res := c.Run(context.Background())
	if res.Status != StatusWarn {
		t.Errorf("missing-account-id should warn (not fail), got %+v", res)
	}
}
