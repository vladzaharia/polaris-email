// Package logbuf is the bridge's in-process log ring buffer.
//
// The heartbeat ticker reads from here every 60s and ships the delta
// to the polaris api (which stashes chunks in R2). The panel renders
// the tail from those R2 objects.
//
// The Ring implements io.Writer so it can stand in as `log.SetOutput`'s
// destination — every line emitted via the stdlib `log` package lands
// here. To keep `docker compose logs` working unchanged, callers also
// hand the Ring an optional secondary writer (typically os.Stderr) that
// every line is mirrored to as it arrives.
//
// Capacity is fixed at construction time (10k lines is the default the
// bridge ships with). When the buffer fills, the oldest line is
// evicted. Each line gets a monotonic `seq` so the heartbeat can ask
// "give me everything after seq N" and the server can dedupe.
package logbuf

import (
	"bytes"
	"io"
	"strings"
	"sync"
	"time"
)

// Line is one captured log line.
type Line struct {
	Seq   int64     `json:"seq"`
	At    time.Time `json:"at"`
	Level string    `json:"level"` // "debug" | "info" | "warn" | "error"
	Msg   string    `json:"msg"`
}

// Ring is a fixed-size, thread-safe ring buffer of log lines plus a
// secondary writer that every accepted line is mirrored to.
type Ring struct {
	mu        sync.Mutex
	capacity  int
	buf       []Line
	head      int   // index of the next write position
	count     int   // number of valid entries (≤ capacity)
	nextSeq   int64 // monotonic sequence number, never resets
	secondary io.Writer
	now       func() time.Time // overridable in tests
}

// New returns a Ring with the given line capacity and an optional
// secondary writer. `capacity` of 0 falls back to 10000.
//
// Sequence numbers start at 1 — the heartbeat protocol uses 0 to mean
// "the bridge hasn't successfully shipped anything yet", so the first
// emitted line is always seq=1.
func New(capacity int, secondary io.Writer) *Ring {
	if capacity <= 0 {
		capacity = 10000
	}
	return &Ring{
		capacity:  capacity,
		buf:       make([]Line, capacity),
		secondary: secondary,
		now:       time.Now,
		nextSeq:   1,
	}
}

// Write implements io.Writer. The stdlib `log` package calls this once
// per emitted line (with a trailing newline). If the secondary writer
// is set, the original bytes are forwarded verbatim so docker compose
// logs keeps showing the same output a developer would see at the TTY.
func (r *Ring) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	// `log` always appends a final \n. Strip it from the captured
	// message but mirror the raw bytes to the secondary unchanged.
	if r.secondary != nil {
		_, _ = r.secondary.Write(p)
	}

	// One Write may carry multiple newline-separated lines in pathological
	// cases (multi-line log entries are rare but legal). Split + capture.
	body := bytes.TrimRight(p, "\n")
	for _, raw := range bytes.Split(body, []byte{'\n'}) {
		if len(raw) == 0 {
			continue
		}
		msg := string(raw)
		r.appendLocked(Line{
			Seq:   r.nextSeq,
			At:    r.now(),
			Level: detectLevel(msg),
			Msg:   msg,
		})
		r.nextSeq++
	}
	return len(p), nil
}

func (r *Ring) appendLocked(l Line) {
	r.buf[r.head] = l
	r.head = (r.head + 1) % r.capacity
	if r.count < r.capacity {
		r.count++
	}
}

// Drain returns every line strictly newer than `sinceSeq`, oldest
// first, plus the new high-water mark (Seq of the last returned line,
// or `sinceSeq` if nothing matched).
func (r *Ring) Drain(sinceSeq int64) (lines []Line, highWater int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	highWater = sinceSeq
	if r.count == 0 {
		return nil, highWater
	}
	// Start index of the oldest line in the ring.
	start := (r.head - r.count + r.capacity) % r.capacity
	out := make([]Line, 0, r.count)
	for i := 0; i < r.count; i++ {
		idx := (start + i) % r.capacity
		l := r.buf[idx]
		if l.Seq > sinceSeq {
			out = append(out, l)
			if l.Seq > highWater {
				highWater = l.Seq
			}
		}
	}
	return out, highWater
}

// HighWater returns the most recently issued sequence number (0 if no
// lines have been written yet). Useful for the bridge's local pointer
// persistence so a restart can resume forwarding cleanly.
func (r *Ring) HighWater() int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	// Seqs start at 1; nextSeq==1 means nothing has been written.
	if r.nextSeq <= 1 {
		return 0
	}
	return r.nextSeq - 1
}

// detectLevel maps common stdlib `log` message prefixes to one of the
// four levels the schema accepts. No prefix → "info".
func detectLevel(msg string) string {
	// Case-insensitive prefix check on the first word.
	first := msg
	if i := strings.IndexAny(msg, " \t:"); i >= 0 {
		first = msg[:i]
	}
	switch strings.ToLower(strings.TrimRight(first, ":")) {
	case "debug":
		return "debug"
	case "warn", "warning":
		return "warn"
	case "error", "err", "fatal":
		return "error"
	default:
		return "info"
	}
}
