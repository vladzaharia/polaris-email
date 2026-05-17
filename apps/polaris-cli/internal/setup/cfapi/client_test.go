package cfapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// helper: build a CF-shaped success envelope around the given result.
func cfSuccess(result any) []byte {
	b, _ := json.Marshal(map[string]any{
		"success":  true,
		"errors":   []any{},
		"messages": []any{},
		"result":   result,
	})
	return b
}

// helper: build a CF-shaped error envelope.
func cfFailure(errs ...map[string]any) []byte {
	b, _ := json.Marshal(map[string]any{
		"success": false,
		"errors":  errs,
	})
	return b
}

func newTestClient(t *testing.T, srv *httptest.Server, opts ...Option) *Client {
	t.Helper()
	all := append([]Option{
		WithBaseURL(srv.URL),
		WithRetryBaseDelay(1 * time.Millisecond),
	}, opts...)
	return NewClient("test-token", "acc-test", all...)
}

func TestClient_SendsBearerAuth(t *testing.T) {
	t.Parallel()
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(cfSuccess(map[string]string{"hello": "world"}))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	var out map[string]string
	if err := c.do(context.Background(), http.MethodGet, "/anything", nil, &out); err != nil {
		t.Fatalf("do: %v", err)
	}
	if gotAuth != "Bearer test-token" {
		t.Errorf("want Authorization=Bearer test-token, got %q", gotAuth)
	}
	if out["hello"] != "world" {
		t.Errorf("decode: %+v", out)
	}
}

func TestClient_RetriesOn429WithRetryAfter(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		if n == 1 {
			w.Header().Set("Retry-After", "0")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write(cfFailure(map[string]any{"code": 10013, "message": "rate limited"}))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(cfSuccess(map[string]string{"ok": "yes"}))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	var out map[string]string
	if err := c.do(context.Background(), http.MethodGet, "/x", nil, &out); err != nil {
		t.Fatalf("do: %v", err)
	}
	if calls.Load() != 2 {
		t.Errorf("want 2 calls (1 retry), got %d", calls.Load())
	}
	if out["ok"] != "yes" {
		t.Errorf("decode: %+v", out)
	}
}

func TestClient_RetriesOn5xx(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		if n < 3 {
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write(cfFailure(map[string]any{"code": 7000, "message": "upstream"}))
			return
		}
		_, _ = w.Write(cfSuccess(map[string]string{"done": "yes"}))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	var out map[string]string
	if err := c.do(context.Background(), http.MethodGet, "/x", nil, &out); err != nil {
		t.Fatalf("do: %v", err)
	}
	if calls.Load() != 3 {
		t.Errorf("want 3 calls (2 retries), got %d", calls.Load())
	}
}

func TestClient_4xxFailsFast(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write(cfFailure(map[string]any{"code": 1234, "message": "bad request"}))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	err := c.do(context.Background(), http.MethodPost, "/x", map[string]string{"a": "b"}, nil)
	if err == nil {
		t.Fatal("want error on 400")
	}
	if calls.Load() != 1 {
		t.Errorf("want 1 call (no retry on 4xx), got %d", calls.Load())
	}
	cf, ok := asCloudflareError(err)
	if !ok {
		t.Fatalf("want CloudflareError, got %T", err)
	}
	if cf.Code != 1234 {
		t.Errorf("want code 1234, got %d", cf.Code)
	}
}

func TestClient_409IsAlreadyExists(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write(cfFailure(map[string]any{"code": 10004, "message": "the bucket already exists"}))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	err := c.do(context.Background(), http.MethodPost, "/r2/buckets", map[string]string{"name": "x"}, nil)
	if err == nil {
		t.Fatal("want error on 409")
	}
	if !IsAlreadyExists(err) {
		t.Errorf("IsAlreadyExists(%v) = false, want true", err)
	}
}

func TestClient_AlreadyExistsFromMessage(t *testing.T) {
	t.Parallel()
	// CF sometimes returns 400 with "already exists" in the message.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write(cfFailure(map[string]any{"code": 7405, "message": "a database with this name already exists"}))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	err := c.do(context.Background(), http.MethodPost, "/d1/database", map[string]string{"name": "x"}, nil)
	if err == nil {
		t.Fatal("want error")
	}
	if !IsAlreadyExists(err) {
		t.Errorf("IsAlreadyExists should detect via message, err=%v", err)
	}
}

func TestClient_MalformedJSONSurfacesError(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("{not json"))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	var out map[string]string
	err := c.do(context.Background(), http.MethodGet, "/x", nil, &out)
	if err == nil {
		t.Fatal("want decode error")
	}
	if !strings.Contains(err.Error(), "decode") {
		t.Errorf("want decode-shaped error, got %v", err)
	}
}

func TestClient_RequestIDPropagatedOnError(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Cf-Request-Id", "req-deadbeef")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write(cfFailure(map[string]any{"code": 10000, "message": "auth"}))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	err := c.do(context.Background(), http.MethodGet, "/x", nil, nil)
	cf, ok := asCloudflareError(err)
	if !ok {
		t.Fatalf("want CloudflareError, got %T", err)
	}
	if cf.RequestID != "req-deadbeef" {
		t.Errorf("want RequestID propagated, got %q", cf.RequestID)
	}
	if !strings.Contains(err.Error(), "req-deadbeef") {
		t.Errorf("Error() should include request id, got %q", err.Error())
	}
}

func TestClient_ContentTypeOnPOST(t *testing.T) {
	t.Parallel()
	var gotCT string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotCT = r.Header.Get("Content-Type")
		_, _ = w.Write(cfSuccess(nil))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	if err := c.do(context.Background(), http.MethodPost, "/x", map[string]string{"k": "v"}, nil); err != nil {
		t.Fatalf("do: %v", err)
	}
	if gotCT != "application/json" {
		t.Errorf("want Content-Type application/json on POST, got %q", gotCT)
	}
}

func TestClient_AccountPath(t *testing.T) {
	t.Parallel()
	c := NewClient("t", "acc-1")
	got := c.accountPath("/d1/database")
	if got != "/accounts/acc-1/d1/database" {
		t.Errorf("accountPath: got %q", got)
	}
}
