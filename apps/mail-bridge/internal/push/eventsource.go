package push

import (
	"encoding/json"
	"fmt"
	"io"
	"sync"
)

// EventSourceSink delivers JMAP Server-Sent Events. The conn handler keeps
// the *http.ResponseWriter open; Deliver writes `event: state\ndata: ...\n\n`.
type EventSourceSink struct {
	mu      sync.Mutex
	id      string
	w       io.Writer
	flusher func()
}

// NewEventSourceSink constructs a sink for the given SSE writer.
func NewEventSourceSink(id string, w io.Writer, flush func()) *EventSourceSink {
	return &EventSourceSink{id: id, w: w, flusher: flush}
}

// ID implements Sink.
func (s *EventSourceSink) ID() string { return s.id }

// Deliver implements Sink.
func (s *EventSourceSink) Deliver(ev StateChange) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(s.w, "event: state\ndata: %s\n\n", string(b)); err != nil {
		return err
	}
	if s.flusher != nil {
		s.flusher()
	}
	return nil
}
