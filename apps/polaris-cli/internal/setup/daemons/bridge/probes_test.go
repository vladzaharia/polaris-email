package bridge

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type stubLookup struct {
	called int
	resp   *LookupResult
	err    error
}

func (s *stubLookup) Lookup(_ context.Context, _ string) (*LookupResult, error) {
	s.called++
	return s.resp, s.err
}

func TestProbeLastSeen_Fresh(t *testing.T) {
	now := time.Now()
	stub := &stubLookup{resp: &LookupResult{Name: "bridge-1", LastSeenAt: &now}}
	r := probeLastSeen(context.Background(), "bridge-1", stub)
	if r.Status != ProbePass {
		t.Fatalf("expected pass, got %+v", r)
	}
}

func TestProbeLastSeen_Stale(t *testing.T) {
	old := time.Now().Add(-5 * time.Minute)
	stub := &stubLookup{resp: &LookupResult{Name: "bridge-1", LastSeenAt: &old}}
	r := probeLastSeen(context.Background(), "bridge-1", stub)
	if r.Status != ProbeFail {
		t.Fatalf("expected fail, got %+v", r)
	}
}

func TestProbeLastSeen_NoHeartbeatYet(t *testing.T) {
	stub := &stubLookup{resp: &LookupResult{Name: "bridge-1"}}
	r := probeLastSeen(context.Background(), "bridge-1", stub)
	if r.Status != ProbeFail {
		t.Fatalf("expected fail, got %+v", r)
	}
}

func TestProbeLastSeen_LookupError(t *testing.T) {
	stub := &stubLookup{err: errors.New("boom")}
	r := probeLastSeen(context.Background(), "bridge-1", stub)
	if r.Status != ProbeFail {
		t.Fatalf("expected fail, got %+v", r)
	}
}

func TestProbeHTTP(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(200)
	}))
	defer srv.Close()
	r := probeHTTP(context.Background(), "webhook", srv.URL+"/healthz", srv.Client())
	if r.Status != ProbePass {
		t.Fatalf("expected pass, got %+v", r)
	}
}

func TestProbeHTTP_5xx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(503)
	}))
	defer srv.Close()
	r := probeHTTP(context.Background(), "webhook", srv.URL+"/healthz", srv.Client())
	if r.Status != ProbeFail {
		t.Fatalf("expected fail, got %+v", r)
	}
}

func TestHTTPBridgeLookup_RoundTrip(t *testing.T) {
	now := time.Now()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("name") != "bridge-iad-1" {
			t.Errorf("expected name param, got %q", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"name":"bridge-iad-1","last_seen_at":"` + now.UTC().Format(time.RFC3339Nano) + `"}`))
	}))
	defer srv.Close()
	l := &HTTPBridgeLookup{BaseURL: srv.URL, Client: srv.Client()}
	got, err := l.Lookup(context.Background(), "bridge-iad-1")
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if got.Name != "bridge-iad-1" || got.LastSeenAt == nil {
		t.Fatalf("unexpected: %+v", got)
	}
}
