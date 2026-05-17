package bridge

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPreflight_FlagsLoopbackPublicURL(t *testing.T) {
	in := validInput()
	in.PublicURL = "http://127.0.0.1:8080"
	r := checkPublicURLNonLoopback(in.PublicURL)
	if r.Status != StatusFail {
		t.Fatalf("expected fail, got %+v", r)
	}
	if !strings.Contains(r.Message, "loopback") {
		t.Fatalf("expected loopback message, got %q", r.Message)
	}
}

func TestPreflight_PolarisAPIReachable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			w.WriteHeader(200)
			return
		}
		w.WriteHeader(404)
	}))
	defer srv.Close()
	r := checkPolarisAPIReachable(context.Background(), srv.URL, srv.Client())
	if r.Status != StatusPass {
		t.Fatalf("expected pass, got %+v", r)
	}
}

func TestPreflight_PolarisAPI_NotReachable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(503)
	}))
	defer srv.Close()
	r := checkPolarisAPIReachable(context.Background(), srv.URL, srv.Client())
	if r.Status != StatusFail {
		t.Fatalf("expected fail, got %+v", r)
	}
}

func TestVerifyCFDNSToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Test injects a custom URL via http.Client.Transport — but
		// VerifyCFDNSToken hard-codes the host. So instead we test
		// using a Client whose Transport rewrites the URL.
		if r.URL.Path != "/client/v4/user/tokens/verify" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Errorf("missing bearer")
		}
		w.WriteHeader(200)
	}))
	defer srv.Close()
	// Rewriting transport: any host → srv host.
	tr := &rewriteTransport{base: srv.Client().Transport, target: srv.URL}
	client := &http.Client{Transport: tr}
	if err := VerifyCFDNSToken(context.Background(), "test-token", client); err != nil {
		t.Fatalf("verify: %v", err)
	}
}

func TestVerifyCFDNSToken_Empty(t *testing.T) {
	if err := VerifyCFDNSToken(context.Background(), "", nil); err == nil {
		t.Fatalf("expected error for empty token")
	}
}

func TestValidateTailscaleAuthKey(t *testing.T) {
	cases := []struct {
		key     string
		wantErr bool
	}{
		{"tskey-auth-aaaaaaaaaaaaaaaaaaaaaaaaa", false},
		{"tskey-auth-short", true},
		{"not-a-key", true},
		{"", true},
	}
	for _, tt := range cases {
		err := ValidateTailscaleAuthKey(tt.key)
		if (err != nil) != tt.wantErr {
			t.Errorf("key %q: got err=%v want err=%v", tt.key, err, tt.wantErr)
		}
	}
}

// rewriteTransport sends every request to `target` while preserving
// the original Path + Header. Used to point VerifyCFDNSToken at our
// httptest server without exposing a base-URL knob in production.
type rewriteTransport struct {
	base   http.RoundTripper
	target string
}

func (t *rewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	originalPath := req.URL.Path
	originalQuery := req.URL.RawQuery
	newURL := t.target + originalPath
	if originalQuery != "" {
		newURL += "?" + originalQuery
	}
	r, err := http.NewRequestWithContext(req.Context(), req.Method, newURL, req.Body)
	if err != nil {
		return nil, err
	}
	for k, v := range req.Header {
		r.Header[k] = v
	}
	return t.base.RoundTrip(r)
}
