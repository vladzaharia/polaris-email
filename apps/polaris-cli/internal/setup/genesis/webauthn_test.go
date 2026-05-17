package genesis

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestPollUntilComplete_ImmediateComplete(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"complete"}`))
	}))
	defer srv.Close()
	done, err := pollUntilComplete(context.Background(), http.DefaultClient,
		SealOptions{APIBaseURL: srv.URL, PollInterval: time.Millisecond, PollTimeout: time.Second},
		"CODE",
	)
	if err != nil {
		t.Fatalf("pollUntilComplete: %v", err)
	}
	if !done {
		t.Error("expected done=true")
	}
}

func TestPollUntilComplete_Expired(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"expired"}`))
	}))
	defer srv.Close()
	done, err := pollUntilComplete(context.Background(), http.DefaultClient,
		SealOptions{APIBaseURL: srv.URL, PollInterval: time.Millisecond, PollTimeout: time.Second},
		"CODE",
	)
	if err != ErrSetupCodeExpired {
		t.Errorf("expected ErrSetupCodeExpired, got %v", err)
	}
	if done {
		t.Error("expected done=false on expired")
	}
}

func TestPollUntilComplete_Timeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"pending"}`))
	}))
	defer srv.Close()
	done, err := pollUntilComplete(context.Background(), http.DefaultClient,
		SealOptions{APIBaseURL: srv.URL, PollInterval: 5 * time.Millisecond, PollTimeout: 25 * time.Millisecond},
		"CODE",
	)
	if err != nil {
		t.Errorf("timeout should return nil err, got %v", err)
	}
	if done {
		t.Error("expected done=false on timeout")
	}
}

func TestPollUntilComplete_TransientErrors(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		n := calls.Add(1)
		if n < 3 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(`{"status":"complete"}`))
	}))
	defer srv.Close()
	done, err := pollUntilComplete(context.Background(), http.DefaultClient,
		SealOptions{APIBaseURL: srv.URL, PollInterval: 5 * time.Millisecond, PollTimeout: 2 * time.Second},
		"CODE",
	)
	if err != nil {
		t.Fatalf("pollUntilComplete: %v", err)
	}
	if !done {
		t.Error("expected done=true after transient errors")
	}
}

func TestPollUntilComplete_ContextCancel(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"pending"}`))
	}))
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(20 * time.Millisecond)
		cancel()
	}()
	done, err := pollUntilComplete(ctx, http.DefaultClient,
		SealOptions{APIBaseURL: srv.URL, PollInterval: 5 * time.Millisecond, PollTimeout: 1 * time.Second},
		"CODE",
	)
	if err == nil {
		t.Error("expected ctx.Err()")
	}
	if done {
		t.Error("expected done=false on cancellation")
	}
}

func TestPollUntilComplete_EmptyCode(t *testing.T) {
	_, err := pollUntilComplete(context.Background(), http.DefaultClient,
		SealOptions{APIBaseURL: "http://x", PollInterval: time.Millisecond, PollTimeout: time.Millisecond},
		"",
	)
	if err == nil {
		t.Fatal("expected error on empty code")
	}
}
