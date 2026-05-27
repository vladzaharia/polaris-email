package mailtest_inproc

import (
	"bytes"
	"io"
	"sync"
)

// ringBuffer is a simple capped in-memory io.Writer used to capture the
// bridge subprocess stderr/stdout. Tests that fail can re-read the tail
// via the BridgeLogs() reader.
type ringBuffer struct {
	mu  sync.Mutex
	buf []byte
	cap int
}

func newRingBuffer(cap int) *ringBuffer {
	return &ringBuffer{cap: cap}
}

func (r *ringBuffer) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.buf = append(r.buf, p...)
	if len(r.buf) > r.cap {
		// Drop the oldest bytes.
		excess := len(r.buf) - r.cap
		r.buf = r.buf[excess:]
	}
	return len(p), nil
}

// NewReader returns a snapshot reader over the current buffer contents.
func (r *ringBuffer) NewReader() io.Reader {
	r.mu.Lock()
	defer r.mu.Unlock()
	snap := make([]byte, len(r.buf))
	copy(snap, r.buf)
	return bytes.NewReader(snap)
}
