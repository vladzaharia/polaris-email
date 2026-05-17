package smoke

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
)

func newTestClient(t *testing.T, baseURL string) *client.Client {
	t.Helper()
	// The signed checks need a key + secret to construct headers; the
	// httptest server doesn't verify them, so any dummy values work.
	c := client.New(baseURL, "test-key-id", "test-secret-value")
	c.HTTPClient = &http.Client{Timeout: 5 * time.Second}
	return c
}

func TestCheckHealthz_Pass(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	r := CheckHealthz(context.Background(), Config{APIBaseURL: srv.URL})
	if r.Status != "pass" {
		t.Errorf("status: want pass, got %s (%s)", r.Status, r.Detail)
	}
}

func TestCheckHealthz_NonOKFails(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	r := CheckHealthz(context.Background(), Config{APIBaseURL: srv.URL})
	if r.Status != "fail" {
		t.Errorf("status: want fail, got %s", r.Status)
	}
	if r.Detail != "HTTP 503" {
		t.Errorf("detail: want HTTP 503, got %q", r.Detail)
	}
}

func TestCheckHealthz_EmptyBaseURLFails(t *testing.T) {
	t.Parallel()
	r := CheckHealthz(context.Background(), Config{})
	if r.Status != "fail" {
		t.Errorf("status: want fail, got %s", r.Status)
	}
}

func TestCheckAdminStatus_Pass(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/admin/status" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		// Verify the signing headers are present.
		if r.Header.Get("X-Polaris-Sig") == "" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"mailboxes": 42,
			"domains":   3,
		})
	}))
	defer srv.Close()
	r := CheckAdminStatus(context.Background(), Config{
		APIBaseURL: srv.URL,
		APIClient:  newTestClient(t, srv.URL),
	})
	if r.Status != "pass" {
		t.Errorf("status: want pass, got %s (%s)", r.Status, r.Detail)
	}
}

func TestCheckAdminStatus_MissingMailboxesFails(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"domains": 3})
	}))
	defer srv.Close()
	r := CheckAdminStatus(context.Background(), Config{
		APIBaseURL: srv.URL,
		APIClient:  newTestClient(t, srv.URL),
	})
	if r.Status != "fail" {
		t.Errorf("status: want fail, got %s", r.Status)
	}
}

func TestCheckAdminStatus_NilClientSkips(t *testing.T) {
	t.Parallel()
	r := CheckAdminStatus(context.Background(), Config{APIBaseURL: "http://x"})
	if r.Status != "skip" {
		t.Errorf("status: want skip, got %s", r.Status)
	}
}

func TestCheckSyntheticOutbound_DeliveredPollPasses(t *testing.T) {
	t.Parallel()
	var statusCalls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/messages":
			_ = json.NewEncoder(w).Encode(map[string]any{"message_id": "mid-abc"})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/messages/mid-abc":
			// First call returns "queued", second call returns "delivered" —
			// exercises the poll loop without burning 60 seconds.
			n := statusCalls.Add(1)
			st := "queued"
			if n >= 2 {
				st = "delivered"
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"status": st})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	r := CheckSyntheticOutbound(context.Background(), Config{
		APIBaseURL:    srv.URL,
		APIClient:     newTestClient(t, srv.URL),
		SyntheticFrom: "from@example.com",
		SyntheticTo:   "to@example.com",
		PollInterval:  10 * time.Millisecond,
		PollTimeout:   2 * time.Second,
	})
	if r.Status != "pass" {
		t.Errorf("status: want pass, got %s (%s)", r.Status, r.Detail)
	}
	if statusCalls.Load() < 2 {
		t.Errorf("expected at least 2 status polls, got %d", statusCalls.Load())
	}
}

func TestCheckSyntheticOutbound_BouncedFails(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			_ = json.NewEncoder(w).Encode(map[string]any{"message_id": "mid-bounce"})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "bounced"})
	}))
	defer srv.Close()

	r := CheckSyntheticOutbound(context.Background(), Config{
		APIBaseURL:    srv.URL,
		APIClient:     newTestClient(t, srv.URL),
		SyntheticFrom: "from@example.com",
		SyntheticTo:   "to@example.com",
		PollInterval:  10 * time.Millisecond,
		PollTimeout:   2 * time.Second,
	})
	if r.Status != "fail" {
		t.Errorf("status: want fail, got %s (%s)", r.Status, r.Detail)
	}
}

func TestCheckSyntheticOutbound_TimeoutFails(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			_ = json.NewEncoder(w).Encode(map[string]any{"message_id": "mid-stuck"})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "queued"})
	}))
	defer srv.Close()

	r := CheckSyntheticOutbound(context.Background(), Config{
		APIBaseURL:    srv.URL,
		APIClient:     newTestClient(t, srv.URL),
		SyntheticFrom: "from@example.com",
		SyntheticTo:   "to@example.com",
		PollInterval:  10 * time.Millisecond,
		PollTimeout:   100 * time.Millisecond,
	})
	if r.Status != "fail" {
		t.Errorf("status: want fail, got %s", r.Status)
	}
}

func TestCheckSyntheticOutbound_SkippedWhenAddressesUnset(t *testing.T) {
	t.Parallel()
	r := CheckSyntheticOutbound(context.Background(), Config{
		APIClient: newTestClient(t, "http://x"),
	})
	if r.Status != "skip" {
		t.Errorf("status: want skip, got %s", r.Status)
	}
}

func TestCheckSyntheticOutbound_SkippedExplicitly(t *testing.T) {
	t.Parallel()
	r := CheckSyntheticOutbound(context.Background(), Config{
		APIClient:     newTestClient(t, "http://x"),
		SyntheticFrom: "f@x",
		SyntheticTo:   "t@x",
		SkipSynthetic: true,
	})
	if r.Status != "skip" {
		t.Errorf("status: want skip, got %s", r.Status)
	}
}

func TestRunAll_OrdersChecks(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/healthz":
			w.WriteHeader(http.StatusOK)
		case "/v1/admin/status":
			_ = json.NewEncoder(w).Encode(map[string]any{"mailboxes": 0, "domains": 0})
		}
	}))
	defer srv.Close()
	results := RunAll(context.Background(), Config{
		APIBaseURL: srv.URL,
		APIClient:  newTestClient(t, srv.URL),
	})
	if len(results) != 3 {
		t.Fatalf("want 3 results, got %d", len(results))
	}
	want := []string{"healthz", "admin-status", "synthetic-outbound"}
	for i, r := range results {
		if r.Name != want[i] {
			t.Errorf("name[%d]: want %s, got %s", i, want[i], r.Name)
		}
	}
}

func TestAnyFailed(t *testing.T) {
	t.Parallel()
	if AnyFailed([]Result{{Status: "pass"}, {Status: "skip"}}) {
		t.Error("no failures: AnyFailed should be false")
	}
	if !AnyFailed([]Result{{Status: "pass"}, {Status: "fail"}}) {
		t.Error("one fail: AnyFailed should be true")
	}
}
