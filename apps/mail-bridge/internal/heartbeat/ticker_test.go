package heartbeat

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	polarissdk "github.com/polaris-mail/polaris-sdk-go"

	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/metrics"
)

// `context` is still referenced by the cancel-during-test scenario;
// build constraint silences unused-import scans if a future edit drops
// that test.
var _ = context.Background

type fakeMirror struct{ n int64 }

func (m *fakeMirror) MessageCount() int64 { return m.n }

func TestStartFiresHeartbeatAtInterval(t *testing.T) {
	// Stand up a fake API that records heartbeat POSTs.
	var received atomic.Int32
	var lastPayload polarissdk.BridgeHeartbeat
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/bridge/heartbeat" {
			http.Error(w, "wrong path", http.StatusNotFound)
			return
		}
		b, _ := io.ReadAll(r.Body)
		var hb polarissdk.BridgeHeartbeat
		if err := json.Unmarshal(b, &hb); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		lastPayload = hb
		received.Add(1)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	client := polarissdk.NewClient(srv.URL)
	client.BridgeID = "01HXBRIDGE0000000000000000"
	client.BridgeSecret = []byte("test-secret-32-bytes-of-padding-text")

	registry := metrics.New()
	registry.IMAP.Inc()
	registry.IMAP.Inc()
	registry.Submissions.Inc()
	registry.Submissions.Inc()
	registry.Submissions.Inc()

	Start(t.Context(), Deps{
		Client:    client,
		Metrics:   registry,
		Mirror:    &fakeMirror{n: 42},
		Interval:  50 * time.Millisecond,
		Settle:    1 * time.Millisecond,
		StartedAt: time.Now().Add(-30 * time.Second),
	})

	// Wait for at least two heartbeats to land.
	deadline := time.Now().Add(2 * time.Second)
	for received.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if got := received.Load(); got < 2 {
		t.Fatalf("expected at least 2 heartbeats within 2s, got %d", got)
	}
	if lastPayload.SchemaVersion != 1 {
		t.Errorf("schema_version: want 1 got %d", lastPayload.SchemaVersion)
	}
	if lastPayload.IMAPSessionsActive != 2 {
		t.Errorf("imap_sessions: want 2 got %d", lastPayload.IMAPSessionsActive)
	}
	if lastPayload.SMTPSubmissions24h != 3 {
		t.Errorf("smtp_submissions_24h: want 3 got %d", lastPayload.SMTPSubmissions24h)
	}
	if lastPayload.MirrorMessageCount != 42 {
		t.Errorf("mirror_message_count: want 42 got %d", lastPayload.MirrorMessageCount)
	}
	if lastPayload.UptimeSeconds < 30 {
		t.Errorf("uptime_seconds: want >=30 got %d", lastPayload.UptimeSeconds)
	}
}

func TestStartSurvivesPostErrors(t *testing.T) {
	// Server returns 500 on every call; the ticker should keep firing
	// rather than panicking or exiting.
	var received atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		received.Add(1)
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer srv.Close()

	client := polarissdk.NewClient(srv.URL)
	client.BridgeID = "01HXBRIDGE0000000000000000"
	client.BridgeSecret = []byte("test-secret")

	Start(t.Context(), Deps{
		Client:   client,
		Metrics:  metrics.New(),
		Interval: 30 * time.Millisecond,
		Settle:   1 * time.Millisecond,
	})

	deadline := time.Now().Add(500 * time.Millisecond)
	for received.Load() < 3 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if got := received.Load(); got < 3 {
		t.Fatalf("ticker should retry on errors; got %d posts in 500ms", got)
	}
}

func TestStartStopsOnContextCancel(t *testing.T) {
	var received atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		received.Add(1)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	client := polarissdk.NewClient(srv.URL)
	client.BridgeID = "01HXBRIDGE0000000000000000"
	client.BridgeSecret = []byte("test-secret")

	ctx, cancel := context.WithCancel(context.Background())
	Start(ctx, Deps{
		Client:   client,
		Metrics:  metrics.New(),
		Interval: 20 * time.Millisecond,
		Settle:   1 * time.Millisecond,
	})

	time.Sleep(60 * time.Millisecond)
	first := received.Load()
	cancel()
	time.Sleep(80 * time.Millisecond)
	second := received.Load()
	// Allow at most one more tick (in-flight at cancel time) — the
	// goroutine should have stopped scheduling new ones.
	if second-first > 1 {
		t.Fatalf("ticker fired %d times after cancel (want ≤1)", second-first)
	}
}
