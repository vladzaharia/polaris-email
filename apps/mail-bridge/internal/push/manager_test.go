package push

import (
	"errors"
	"sync"
	"testing"
)

type captureSink struct {
	id   string
	mu   sync.Mutex
	got  []StateChange
	fail bool
}

func (c *captureSink) ID() string { return c.id }
func (c *captureSink) Deliver(ev StateChange) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.fail {
		return errors.New("nope")
	}
	c.got = append(c.got, ev)
	return nil
}

func TestSubscribeBroadcast(t *testing.T) {
	m := New()
	a := &captureSink{id: "a"}
	b := &captureSink{id: "b"}
	m.Subscribe("mb1", a)
	m.Subscribe("mb1", b)
	m.Subscribe("mb2", &captureSink{id: "c"})

	ev := StateChange{Type: "StateChange", Changed: map[string]map[string]string{"mb1": {"Email": "5"}}}
	m.Broadcast("mb1", ev)

	if len(a.got) != 1 || len(b.got) != 1 {
		t.Fatalf("expected both sinks to receive once, got a=%d b=%d", len(a.got), len(b.got))
	}
	if m.Count("mb1") != 2 || m.Count("mb2") != 1 {
		t.Fatalf("counts wrong: %d %d", m.Count("mb1"), m.Count("mb2"))
	}

	m.Unsubscribe("mb1", "a")
	if m.Count("mb1") != 1 {
		t.Fatalf("after unsub, want 1, got %d", m.Count("mb1"))
	}
}

func TestFailingSinkDropped(t *testing.T) {
	m := New()
	bad := &captureSink{id: "bad", fail: true}
	m.Subscribe("mb1", bad)
	m.Broadcast("mb1", StateChange{Type: "StateChange"})
	if m.Count("mb1") != 0 {
		t.Fatal("failing sink should be unsubscribed")
	}
}
