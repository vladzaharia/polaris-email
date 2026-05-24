// Package metrics is the bridge-local in-process counter substrate that
// feeds the heartbeat payload. Three counters live here:
//
//   * `Sessions` — current number of live IMAP connections. Bump on
//     Backend.NewSession, decrement on Session.Close. `sync/atomic` is
//     enough since reads and writes never need transactional grouping.
//
//   * `Window24h` — generic 24h rolling-bucket counter. Used for SMTP
//     submission success counts and bridge-local error counts. Bucketed
//     by minute (1440 buckets) so eviction is O(1) and the read returns
//     a stable sum across the window. A mutex serialises the bucket
//     advance + write; the workload is low (well under 1k events per
//     minute even on a chatty bridge) so contention is irrelevant.
//
// The whole package is dependency-free except `sync` + `sync/atomic` +
// `time` to keep it cheap to import from every backend handler.
package metrics

import (
	"sync"
	"sync/atomic"
	"time"
)

// Sessions tracks the live IMAP-session gauge.
//
// Zero value is ready to use.
type Sessions struct {
	n int64
}

// Inc bumps the gauge. Call once on session accept.
func (s *Sessions) Inc() { atomic.AddInt64(&s.n, 1) }

// Dec decrements the gauge. Call once on session close. Safe to call
// even if Inc was never called (e.g. a session that failed to greet);
// the value will go negative and the read will surface that. We don't
// clamp because a persistently negative count is a real bug worth
// catching, not papering over.
func (s *Sessions) Dec() { atomic.AddInt64(&s.n, -1) }

// Load returns the current count.
func (s *Sessions) Load() int { return int(atomic.LoadInt64(&s.n)) }

// Window24h is a rolling counter over a 24-hour window, bucketed by
// minute. Bucket count is fixed at 1440; per-bucket entries are int32
// (a single bridge will never exceed ~2B events per minute).
//
// Zero value is ready to use; the first Inc seeds `start`.
type Window24h struct {
	mu      sync.Mutex
	buckets [1440]int32
	start   time.Time // start-of-window timestamp for buckets[0]
	now     func() time.Time
}

// nowFn returns the time function (default: time.Now). Test-only seam.
func (w *Window24h) nowFn() time.Time {
	if w.now != nil {
		return w.now()
	}
	return time.Now()
}

// SetNow installs a custom clock. Tests use this to fast-forward the
// rolling window without sleeping. Production code never calls it.
func (w *Window24h) SetNow(f func() time.Time) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.now = f
}

// advanceLocked rolls the ring buffer forward to `t`, zeroing buckets
// that have aged out. Caller must hold `w.mu`.
func (w *Window24h) advanceLocked(t time.Time) {
	if w.start.IsZero() {
		// First write — anchor the window so bucket 0 corresponds to
		// the current minute floor.
		w.start = t.Truncate(time.Minute)
		return
	}
	elapsed := int(t.Truncate(time.Minute).Sub(w.start) / time.Minute)
	if elapsed <= 0 {
		return
	}
	if elapsed >= len(w.buckets) {
		// More than 24h passed — zero everything and re-anchor.
		clear(w.buckets[:])
		w.start = t.Truncate(time.Minute)
		return
	}
	// Rotate: shift the buckets left by `elapsed` minutes. Zero the
	// freshly-uncovered tail. Allocation-free: we operate on the array
	// in place rather than reslicing into a new buffer.
	copy(w.buckets[:], w.buckets[elapsed:])
	for i := len(w.buckets) - elapsed; i < len(w.buckets); i++ {
		w.buckets[i] = 0
	}
	w.start = w.start.Add(time.Duration(elapsed) * time.Minute)
}

// Inc records one event at the current time.
func (w *Window24h) Inc() { w.Add(1) }

// Add records `n` events at the current time.
func (w *Window24h) Add(n int32) {
	w.mu.Lock()
	defer w.mu.Unlock()
	t := w.nowFn()
	w.advanceLocked(t)
	// Write into the most-recent bucket. Always [len-1] after advance.
	w.buckets[len(w.buckets)-1] += n
}

// Sum returns the total event count over the trailing 24h.
func (w *Window24h) Sum() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.advanceLocked(w.nowFn())
	var s int64
	for _, b := range w.buckets {
		s += int64(b)
	}
	return int(s)
}

// Registry bundles the three counters the heartbeat ticker needs. Keep
// it as a struct of plain pointers so backends can take just the one
// they need (the IMAP backend wants only Sessions; SMTP wants only
// Submissions + Errors) without importing the rest.
type Registry struct {
	IMAP        *Sessions
	Submissions *Window24h
	Errors      *Window24h
}

// New constructs a Registry with fresh counters.
func New() *Registry {
	return &Registry{
		IMAP:        &Sessions{},
		Submissions: &Window24h{},
		Errors:      &Window24h{},
	}
}
