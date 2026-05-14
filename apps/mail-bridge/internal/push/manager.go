// Package push fans state-change events out to IMAP IDLE clients,
// JMAP WebSocket clients, and JMAP EventSource clients.
//
// The Manager is the single registry; webhook handlers call Broadcast when
// polaris fires a `message.received` event; each subscriber type wraps its
// connection in a Sink and registers via Subscribe.
package push

import (
	"sync"
)

// StateChange is the JMAP RFC 8887 payload — `changed: { [accountId]: { [type]: state } }`.
type StateChange struct {
	Type    string                       `json:"@type"`
	Changed map[string]map[string]string `json:"changed"`
}

// Sink is anything that can receive a StateChange. Implementations may
// translate the event into protocol-native frames (JSON-over-WebSocket,
// SSE `data:`, or an IMAP `* <n> EXISTS` line).
type Sink interface {
	Deliver(StateChange) error
	// ID is a per-connection unique identifier used by Unsubscribe.
	ID() string
}

// Manager keeps subscribers grouped by mailbox.
type Manager struct {
	mu   sync.RWMutex
	subs map[string]map[string]Sink // mailbox_id -> sinkID -> sink
}

// New creates an empty manager.
func New() *Manager {
	return &Manager{subs: map[string]map[string]Sink{}}
}

// Subscribe adds a sink to a mailbox's broadcast group.
func (m *Manager) Subscribe(mailboxID string, sink Sink) {
	m.mu.Lock()
	defer m.mu.Unlock()
	g, ok := m.subs[mailboxID]
	if !ok {
		g = map[string]Sink{}
		m.subs[mailboxID] = g
	}
	g[sink.ID()] = sink
}

// Unsubscribe removes a sink (idempotent).
func (m *Manager) Unsubscribe(mailboxID, sinkID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if g, ok := m.subs[mailboxID]; ok {
		delete(g, sinkID)
		if len(g) == 0 {
			delete(m.subs, mailboxID)
		}
	}
}

// Broadcast delivers ev to every sink subscribed to mailboxID. Failing sinks
// are dropped silently; the connection layer is responsible for closing them.
func (m *Manager) Broadcast(mailboxID string, ev StateChange) {
	m.mu.RLock()
	g := m.subs[mailboxID]
	sinks := make([]Sink, 0, len(g))
	for _, s := range g {
		sinks = append(sinks, s)
	}
	m.mu.RUnlock()
	for _, s := range sinks {
		if err := s.Deliver(ev); err != nil {
			// Best-effort drop. The conn-owning goroutine will notice on
			// its next read and call Unsubscribe.
			m.Unsubscribe(mailboxID, s.ID())
		}
	}
}

// Count returns the current subscriber count for a mailbox (for diagnostics).
func (m *Manager) Count(mailboxID string) int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.subs[mailboxID])
}
