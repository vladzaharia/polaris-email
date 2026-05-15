package polarissdk

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestParseAPIErrorWithEnvelope(t *testing.T) {
	body := []byte(`{"error":{"code":"rate_limited","message":"slow down","retryable":true,"request_id":"req_abc"}}`)
	h := http.Header{}
	h.Set("X-Request-Id", "req_header_fallback")
	apiErr := ParseAPIError(429, body, h)
	if apiErr.Code != "rate_limited" {
		t.Fatalf("code = %q", apiErr.Code)
	}
	if !apiErr.Retryable {
		t.Fatal("expected retryable=true")
	}
	if apiErr.Status != 429 {
		t.Fatalf("status = %d", apiErr.Status)
	}
	// Envelope's request_id wins over the header.
	if apiErr.RequestID != "req_abc" {
		t.Fatalf("request_id = %q", apiErr.RequestID)
	}
	if got := apiErr.Error(); got != "polaris: rate_limited: slow down" {
		t.Fatalf("Error() = %q", got)
	}
}

func TestParseAPIErrorEnvelopeNoRequestID(t *testing.T) {
	// Envelope lacks request_id; the header should fill in.
	body := []byte(`{"error":{"code":"forbidden","message":"nope","retryable":false}}`)
	h := http.Header{}
	h.Set("X-Request-Id", "req_from_header")
	apiErr := ParseAPIError(403, body, h)
	if apiErr.RequestID != "req_from_header" {
		t.Fatalf("request_id = %q", apiErr.RequestID)
	}
	if apiErr.Retryable {
		t.Fatal("expected retryable=false")
	}
}

func TestParseAPIErrorNonJSONBody(t *testing.T) {
	// CF returns an HTML 502 page; the SDK must still produce a typed error.
	body := []byte("<html><body>Bad gateway</body></html>")
	h := http.Header{}
	h.Set("X-Request-Id", "req_502")
	apiErr := ParseAPIError(502, body, h)
	if apiErr.Code != "unknown" {
		t.Fatalf("code = %q", apiErr.Code)
	}
	if !apiErr.Retryable {
		t.Fatal("status >= 500 should be retryable=true on parse failure")
	}
	if apiErr.RequestID != "req_502" {
		t.Fatalf("request_id = %q", apiErr.RequestID)
	}
}

func TestParseAPIErrorEmptyBodyNilHeaders(t *testing.T) {
	apiErr := ParseAPIError(404, nil, nil)
	if apiErr.Code != "unknown" {
		t.Fatalf("code = %q", apiErr.Code)
	}
	if apiErr.Retryable {
		t.Fatal("status < 500 should be retryable=false on parse failure")
	}
	if apiErr.RequestID != "" {
		t.Fatalf("request_id = %q", apiErr.RequestID)
	}
}

func TestDoJSONReturnsAPIErrorOnNon2xx(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/messages/x", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Request-Id", "req_xyz")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":{"code":"rate_limited","message":"slow down","retryable":true,"request_id":"req_xyz"}}`))
	})
	c, srv := newTestClient(t, mux)
	defer srv.Close()

	err := c.DeleteMessage(context.Background(), "x")
	if err == nil {
		t.Fatal("expected error")
	}
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected *APIError, got %T: %v", err, err)
	}
	if apiErr.Code != "rate_limited" || apiErr.Status != 429 || !apiErr.Retryable || apiErr.RequestID != "req_xyz" {
		t.Fatalf("apiErr = %+v", apiErr)
	}
	if !IsRetryable(err) {
		t.Fatal("IsRetryable should return true for retryable APIError")
	}
}

func TestDoJSONReturnsAPIErrorOnHTML502(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/messages/get", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Header().Set("X-Request-Id", "req_502")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("<html>bad gateway</html>"))
	})
	c, srv := newTestClient(t, mux)
	defer srv.Close()

	_, err := c.BulkGetMessages(context.Background(), []string{"a"})
	if err == nil {
		t.Fatal("expected error")
	}
	apiErr, ok := AsAPIError(err)
	if !ok {
		t.Fatalf("expected *APIError, got %T: %v", err, err)
	}
	if apiErr.Code != "unknown" || apiErr.Status != 502 || !apiErr.Retryable {
		t.Fatalf("apiErr = %+v", apiErr)
	}
	if !IsRetryable(err) {
		t.Fatal("502 should be retryable")
	}
}

func TestDoJSONReturnsAPIErrorOnNonRetryable4xx(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/messages/x", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":{"code":"scope_violation","message":"from outside scope","retryable":false,"request_id":"req_403"}}`))
	})
	c, srv := newTestClient(t, mux)
	defer srv.Close()

	err := c.DeleteMessage(context.Background(), "x")
	if err == nil {
		t.Fatal("expected error")
	}
	apiErr, ok := AsAPIError(err)
	if !ok {
		t.Fatalf("expected *APIError, got %T: %v", err, err)
	}
	if apiErr.Code != "scope_violation" || apiErr.Retryable {
		t.Fatalf("apiErr = %+v", apiErr)
	}
	if IsRetryable(err) {
		t.Fatal("scope_violation must not be retryable")
	}
}

func TestDoReturnsNetworkErrorUnwrapped(t *testing.T) {
	// Point the client at a closed server so the request errors at the
	// transport layer. The error must not be an *APIError so callers can
	// still use errors.Is for transport-level conditions.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	srv.Close() // close immediately
	c := NewClient(srv.URL)
	c.KeyID = "01H0000000000000000000000K"
	c.KeySecret = []byte("test-secret-key")
	c.HTTPClient = &http.Client{Timeout: 100 * time.Millisecond}

	err := c.DeleteMessage(context.Background(), "x")
	if err == nil {
		t.Fatal("expected transport error")
	}
	if _, ok := AsAPIError(err); ok {
		t.Fatalf("transport error must not be *APIError: %v", err)
	}
}

func TestIsRetryableTimeout(t *testing.T) {
	// A simulated net.Error with Timeout()=true must be flagged retryable.
	err := &fakeNetErr{timeout: true}
	if !IsRetryable(err) {
		t.Fatal("IsRetryable should be true for timeout net.Error")
	}
}

func TestIsRetryableNonNetNonAPI(t *testing.T) {
	if IsRetryable(errors.New("oops")) {
		t.Fatal("unknown error must not be retryable")
	}
	if IsRetryable(nil) {
		t.Fatal("nil error must not be retryable")
	}
}

func TestAPIErrorErrorEmptyMessage(t *testing.T) {
	apiErr := &APIError{Code: "unknown", Status: 500}
	if got := apiErr.Error(); got != "polaris: unknown" {
		t.Fatalf("Error() = %q", got)
	}
}

// fakeNetErr satisfies net.Error so we can exercise IsRetryable's timeout
// branch deterministically. The standard-library net.OpError types depend on
// system-level conditions that are hard to reproduce in a unit test.
type fakeNetErr struct {
	timeout bool
}

func (f *fakeNetErr) Error() string   { return "fake net error" }
func (f *fakeNetErr) Timeout() bool   { return f.timeout }
func (f *fakeNetErr) Temporary() bool { return false } //nolint:staticcheck

// Compile-time assertion that fakeNetErr satisfies net.Error.
var _ net.Error = (*fakeNetErr)(nil)
