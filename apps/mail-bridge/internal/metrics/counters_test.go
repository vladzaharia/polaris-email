package metrics

import (
	"sync"
	"testing"
	"time"
)

func TestSessionsIncDec(t *testing.T) {
	var s Sessions
	if got := s.Load(); got != 0 {
		t.Fatalf("initial load: want 0 got %d", got)
	}
	s.Inc()
	s.Inc()
	s.Inc()
	if got := s.Load(); got != 3 {
		t.Fatalf("after 3 inc: want 3 got %d", got)
	}
	s.Dec()
	if got := s.Load(); got != 2 {
		t.Fatalf("after 1 dec: want 2 got %d", got)
	}
}

func TestSessionsConcurrent(t *testing.T) {
	// 1000 goroutines * (Inc; Dec) should net to zero. Run with
	// `go test -race` to catch any non-atomic regression.
	var s Sessions
	var wg sync.WaitGroup
	const n = 1000
	for range n {
		wg.Go(func() {
			s.Inc()
			s.Dec()
		})
	}
	wg.Wait()
	if got := s.Load(); got != 0 {
		t.Fatalf("after balanced inc/dec: want 0 got %d", got)
	}
}

func TestWindow24hRollingEviction(t *testing.T) {
	var w Window24h
	now := time.Date(2026, 5, 23, 12, 0, 0, 0, time.UTC)
	w.SetNow(func() time.Time { return now })

	w.Inc()
	w.Inc()
	w.Inc()
	if got := w.Sum(); got != 3 {
		t.Fatalf("after 3 inc: want 3 got %d", got)
	}

	// Advance 30 minutes — counts still inside the window.
	now = now.Add(30 * time.Minute)
	if got := w.Sum(); got != 3 {
		t.Fatalf("after +30m: want 3 got %d", got)
	}

	// Add a few more at the new time.
	w.Add(5)
	if got := w.Sum(); got != 8 {
		t.Fatalf("after +5 at 30m: want 8 got %d", got)
	}

	// Advance past 24h — the original 3 should evict but the +5 should
	// stay.
	now = now.Add(24 * time.Hour)
	if got := w.Sum(); got != 0 {
		t.Fatalf("after +24h: original counts should evict, want 0 got %d", got)
	}
}

func TestWindow24hConcurrentAdd(t *testing.T) {
	// 1000 goroutines, each Add(1). Race-detector should be clean.
	var w Window24h
	now := time.Date(2026, 5, 23, 12, 0, 0, 0, time.UTC)
	w.SetNow(func() time.Time { return now })
	var wg sync.WaitGroup
	const n = 1000
	for range n {
		wg.Go(func() {
			w.Inc()
		})
	}
	wg.Wait()
	if got := w.Sum(); got != n {
		t.Fatalf("after %d concurrent inc: want %d got %d", n, n, got)
	}
}
