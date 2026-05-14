package push

import (
	"encoding/json"
	"net/http"
	"sync"
)

// WebSocketSink delivers JMAP WebSocket frames. This skeleton uses a thin
// abstraction: a `Frame` channel wired by the connection-owning goroutine.
// TODO(production): integrate `nhooyr.io/websocket` or `gorilla/websocket`
// for real frame writes; the current implementation only serializes
// StateChange into the channel for the conn loop to send.
type WebSocketSink struct {
	mu     sync.Mutex
	id     string
	frames chan []byte
	closed bool
}

// NewWebSocketSink builds a sink with the given outbound frame channel.
func NewWebSocketSink(id string, frames chan []byte) *WebSocketSink {
	return &WebSocketSink{id: id, frames: frames}
}

// ID implements Sink.
func (s *WebSocketSink) ID() string { return s.id }

// Deliver implements Sink.
func (s *WebSocketSink) Deliver(ev StateChange) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return http.ErrServerClosed
	}
	b, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	select {
	case s.frames <- b:
		return nil
	default:
		// Drop on backpressure — the conn is too slow.
		return http.ErrAbortHandler
	}
}

// Close marks the sink dead. Subsequent Deliver calls return ErrServerClosed.
func (s *WebSocketSink) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.closed {
		s.closed = true
		close(s.frames)
	}
}
