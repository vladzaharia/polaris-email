package logbuf

import (
	"bytes"
	"testing"
	"time"
)

func TestWriteAndDrain(t *testing.T) {
	var mirror bytes.Buffer
	r := New(3, &mirror)
	r.now = func() time.Time { return time.Unix(1700000000, 0).UTC() }
	if _, err := r.Write([]byte("hello\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := r.Write([]byte("WARN: degraded mode\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if got := mirror.String(); got != "hello\nWARN: degraded mode\n" {
		t.Fatalf("secondary mirror=%q", got)
	}
	lines, hw := r.Drain(0)
	if len(lines) != 2 {
		t.Fatalf("drain len=%d want 2", len(lines))
	}
	if lines[0].Msg != "hello" || lines[0].Level != "info" || lines[0].Seq != 1 {
		t.Errorf("line 0 = %+v", lines[0])
	}
	if lines[1].Msg != "WARN: degraded mode" || lines[1].Level != "warn" || lines[1].Seq != 2 {
		t.Errorf("line 1 = %+v", lines[1])
	}
	if hw != 2 {
		t.Errorf("high water = %d want 2", hw)
	}
}

func TestRingEviction(t *testing.T) {
	r := New(2, nil)
	for range 5 {
		_, _ = r.Write([]byte("msg\n"))
	}
	lines, hw := r.Drain(0)
	if len(lines) != 2 {
		t.Fatalf("len=%d want 2 (capacity)", len(lines))
	}
	// Seqs 1..5 emitted; capacity 2 keeps the last two = seqs 4 and 5.
	if lines[0].Seq != 4 || lines[1].Seq != 5 {
		t.Errorf("seqs = %d, %d (want 4, 5)", lines[0].Seq, lines[1].Seq)
	}
	if hw != 5 {
		t.Errorf("high water = %d want 5", hw)
	}
}

func TestDrainSince(t *testing.T) {
	r := New(10, nil)
	for range 5 {
		_, _ = r.Write([]byte("msg\n"))
	}
	// Ask for everything after seq 3 — should yield seqs 4 and 5.
	lines, hw := r.Drain(3)
	if len(lines) != 2 {
		t.Fatalf("len=%d want 2", len(lines))
	}
	if lines[0].Seq != 4 || lines[1].Seq != 5 {
		t.Errorf("seqs = %d, %d", lines[0].Seq, lines[1].Seq)
	}
	if hw != 5 {
		t.Errorf("high water = %d want 5", hw)
	}
}

func TestDetectLevel(t *testing.T) {
	cases := []struct {
		msg  string
		want string
	}{
		{"hello world", "info"},
		{"DEBUG: trace", "debug"},
		{"WARN: stale", "warn"},
		{"warning: deprecated", "warn"},
		{"ERROR: oops", "error"},
		{"fatal stop", "error"},
		{"err: ...", "error"},
	}
	for _, c := range cases {
		if got := detectLevel(c.msg); got != c.want {
			t.Errorf("detectLevel(%q) = %q want %q", c.msg, got, c.want)
		}
	}
}
