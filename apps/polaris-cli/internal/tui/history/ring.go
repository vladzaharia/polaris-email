// Package history — fixed-size append-only ring buffers for client-side
// metric accumulation. The API exposes only window-aggregates, so the TUI
// remembers samples across polls to produce sparklines.
package history

import "time"

// Sample is one timestamped data point.
type Sample[T any] struct {
	At time.Time
	V  T
}

// Ring is a generic fixed-capacity append-only buffer.
type Ring[T any] struct {
	buf      []Sample[T]
	head     int
	full     bool
	capacity int
}

// New allocates an empty ring of the given capacity.
func New[T any](capacity int) *Ring[T] {
	if capacity < 1 {
		capacity = 1
	}
	return &Ring[T]{buf: make([]Sample[T], capacity), capacity: capacity}
}

// Push appends one sample.
func (r *Ring[T]) Push(at time.Time, v T) {
	r.buf[r.head] = Sample[T]{At: at, V: v}
	r.head++
	if r.head >= r.capacity {
		r.head = 0
		r.full = true
	}
}

// Len returns the number of stored samples.
func (r *Ring[T]) Len() int {
	if r.full {
		return r.capacity
	}
	return r.head
}

// Last returns the most-recent sample (or zero + false if empty).
func (r *Ring[T]) Last() (Sample[T], bool) {
	n := r.Len()
	if n == 0 {
		var z Sample[T]
		return z, false
	}
	idx := r.head - 1
	if idx < 0 {
		idx = r.capacity - 1
	}
	return r.buf[idx], true
}

// Snapshot returns samples in chronological order (oldest first).
func (r *Ring[T]) Snapshot() []Sample[T] {
	n := r.Len()
	out := make([]Sample[T], 0, n)
	if !r.full {
		out = append(out, r.buf[:r.head]...)
		return out
	}
	out = append(out, r.buf[r.head:]...)
	out = append(out, r.buf[:r.head]...)
	return out
}

// Clear empties the ring.
func (r *Ring[T]) Clear() {
	for i := range r.buf {
		var z Sample[T]
		r.buf[i] = z
	}
	r.head = 0
	r.full = false
}
