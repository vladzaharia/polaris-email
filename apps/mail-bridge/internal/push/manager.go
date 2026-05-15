// Package push fans state-change events out to IMAP IDLE clients.
//
// The Manager is the single registry; webhook handlers call Broadcast when
// polaris fires a `message.received` event; each subscriber type wraps its
// connection in a Sink and registers via Subscribe.
package push

import (
	"sync"
)

// StateChange describes a mailbox state delta. The fields are kept as a
// generic key/value map so the underlying transport (today: IMAP IDLE) can
// translate the event into protocol-native frames without coupling the
// manager to a specific wire shape.
type StateChange struct {
	Type    string                       `json:"@type"`
	Changed map[string]map[string]string `json:"changed"`
}

// Sink is anything that can receive a StateChange. Implementations translate
// the event into a protocol-native frame (today only IMAP IDLE's
// `* <n> EXISTS` untagged response).
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
