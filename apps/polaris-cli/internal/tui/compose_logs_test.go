package tui

import (
	"fmt"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// step is a tiny convenience that drives a model with one message and
// returns the new model (unwrapped) so chained calls stay readable.
func step(m ComposeLogsModel, msg tea.Msg) ComposeLogsModel {
	next, _ := m.Update(msg)
	return next.(ComposeLogsModel)
}

func TestComposeLogsModel_TitleRendersHeader(t *testing.T) {
	m := NewComposeLogsModel(
		ComposeLogsTitle{Name: "edge-eu1", ImageTag: "v1.4.2", Mode: "tailscale"},
		[]string{"tls-smtps", "imap-greeting", "http-webhook"},
	)
	// Stamp a window size so the view has dimensions to render against.
	m = step(m, tea.WindowSizeMsg{Width: 100, Height: 30})

	v := m.View()
	for _, want := range []string{"edge-eu1", "v1.4.2", "tailscale"} {
		if !strings.Contains(v, want) {
			t.Errorf("expected View() to contain %q, got:\n%s", want, v)
		}
	}
}

func TestComposeLogsModel_AppendsLogLines(t *testing.T) {
	m := NewComposeLogsModel(
		ComposeLogsTitle{Name: "x", ImageTag: "v0", Mode: "local"},
		[]string{"tls-smtps"},
	)
	m = step(m, tea.WindowSizeMsg{Width: 80, Height: 24})
	m = step(m, ComposeLogLineMsg{Line: "bridge: starting on :465"})
	m = step(m, ComposeLogLineMsg{Line: "bridge: imap listener up"})

	if got := len(m.Logs()); got != 2 {
		t.Fatalf("want 2 log lines, got %d", got)
	}
	if !strings.Contains(m.View(), "imap listener up") {
		t.Errorf("expected view to include the latest log line, got:\n%s", m.View())
	}
}

// TestComposeLogsModel_BoundedRingBuffer covers the OOM-defence:
// pushing 1001+ lines must not let the slice grow unbounded. We push
// 1500 lines and assert the buffer stays at or below maxLogs (1000)
// and that the very oldest line has been evicted.
func TestComposeLogsModel_BoundedRingBuffer(t *testing.T) {
	m := NewComposeLogsModel(
		ComposeLogsTitle{Name: "x", ImageTag: "v0", Mode: "local"},
		nil,
	)
	const total = 1500
	for i := 0; i < total; i++ {
		m = step(m, ComposeLogLineMsg{Line: fmt.Sprintf("line-%04d", i)})
	}
	got := len(m.Logs())
	if got > 1000 {
		t.Fatalf("ring buffer unbounded: got %d lines, want <= 1000", got)
	}
	if got < 100 {
		t.Fatalf("ring buffer truncated too aggressively: got %d lines", got)
	}
	// Oldest line must have been dropped.
	for _, line := range m.Logs() {
		if line == "line-0000" {
			t.Fatalf("oldest line line-0000 should have been evicted")
		}
	}
	// Newest line must still be present.
	last := m.Logs()[len(m.Logs())-1]
	if !strings.HasSuffix(last, fmt.Sprintf("line-%04d", total-1)) {
		t.Errorf("newest line missing: got %q", last)
	}
}

func TestComposeLogsModel_ProbeResultsPopulateBottomPanel(t *testing.T) {
	m := NewComposeLogsModel(
		ComposeLogsTitle{Name: "edge", ImageTag: "v1", Mode: "local"},
		[]string{"tls-smtps", "imap-greeting", "http-webhook", "control-plane"},
	)
	m = step(m, tea.WindowSizeMsg{Width: 100, Height: 30})

	// Four probes in order.
	m = step(m, BridgeProbeResultMsg{Name: "tls-smtps", Status: "pass", Detail: "TLS 1.3 EE"})
	m = step(m, BridgeProbeResultMsg{Name: "imap-greeting", Status: "pass", Detail: "CAPABILITY received"})
	m = step(m, BridgeProbeResultMsg{Name: "http-webhook", Status: "pass", Detail: "200 OK"})
	m = step(m, BridgeProbeResultMsg{Name: "control-plane", Status: "pass", Detail: "last_seen <1s ago"})

	if got := len(m.Probes()); got != 4 {
		t.Fatalf("want 4 probe rows, got %d", got)
	}
	v := m.View()
	for _, want := range []string{"TLS 1.3 EE", "CAPABILITY received", "200 OK", "last_seen <1s ago"} {
		if !strings.Contains(v, want) {
			t.Errorf("probe table missing %q in view:\n%s", want, v)
		}
	}
	// Status column up-cases.
	if !strings.Contains(v, "PASS") {
		t.Errorf("expected upper-cased PASS in view, got:\n%s", v)
	}
}

// TestComposeLogsModel_DoneTerminatesProgram verifies the model signals
// tea.Quit (via the second return value being tea.Quit) when the state
// transitions to "done".
func TestComposeLogsModel_DoneTerminatesProgram(t *testing.T) {
	m := NewComposeLogsModel(
		ComposeLogsTitle{Name: "x", ImageTag: "v0", Mode: "local"},
		nil,
	)
	next, cmd := m.Update(ComposeStateMsg{State: ComposeStateDone})
	nm := next.(ComposeLogsModel)
	if !nm.Finished() {
		t.Fatalf("model did not mark itself finished after state=done")
	}
	if cmd == nil {
		t.Fatalf("expected tea.Quit cmd, got nil")
	}
	// Drive the returned cmd; tea.Quit returns a tea.QuitMsg.
	if msg := cmd(); msg == nil {
		t.Fatalf("expected non-nil msg from tea.Quit cmd")
	}
}

// TestComposeLogsModel_FailedTerminatesProgram mirrors the done case
// for the failed terminal state.
func TestComposeLogsModel_FailedTerminatesProgram(t *testing.T) {
	m := NewComposeLogsModel(
		ComposeLogsTitle{Name: "x", ImageTag: "v0", Mode: "local"},
		nil,
	)
	next, cmd := m.Update(ComposeStateMsg{State: ComposeStateFailed})
	nm := next.(ComposeLogsModel)
	if !nm.Finished() {
		t.Fatalf("model did not mark itself finished after state=failed")
	}
	if cmd == nil {
		t.Fatalf("expected tea.Quit cmd on failure, got nil")
	}
}

func TestComposeLogsModel_QuitKey(t *testing.T) {
	m := NewComposeLogsModel(
		ComposeLogsTitle{Name: "x", ImageTag: "v0", Mode: "local"},
		nil,
	)
	for _, key := range []string{"q", "esc", "ctrl+c"} {
		_, cmd := m.Update(tea.KeyMsg{Type: keyType(key), Runes: []rune(key)})
		if cmd == nil {
			t.Errorf("key %q did not return a quit cmd", key)
		}
	}
}

// keyType maps a string key into tea.KeyType for the few keys we care
// about. Anything else falls back to KeyRunes, which is what bubble tea
// uses for plain alphabetic characters.
func keyType(s string) tea.KeyType {
	switch s {
	case "esc":
		return tea.KeyEsc
	case "ctrl+c":
		return tea.KeyCtrlC
	default:
		return tea.KeyRunes
	}
}

func TestComposeLogsModel_StateTransitions(t *testing.T) {
	m := NewComposeLogsModel(
		ComposeLogsTitle{Name: "x", ImageTag: "v0", Mode: "local"},
		[]string{"a", "b"},
	)
	if got := m.State(); got != ComposeStateUpStarting {
		t.Fatalf("initial state want up-starting, got %q", got)
	}
	m = step(m, ComposeStateMsg{State: ComposeStateVerifying})
	if got := m.State(); got != ComposeStateVerifying {
		t.Fatalf("after transition want verifying, got %q", got)
	}
	m = step(m, ComposeStateMsg{State: ComposeStateHealthy})
	if got := m.State(); got != ComposeStateHealthy {
		t.Fatalf("after transition want healthy, got %q", got)
	}
	if m.Finished() {
		t.Fatalf("healthy is not terminal; model should not be finished yet")
	}
}

// TestComposeLogsModel_ProbeUpdateReplaces verifies that re-sending a
// probe result for the same name replaces (does not duplicate) the row.
func TestComposeLogsModel_ProbeUpdateReplaces(t *testing.T) {
	m := NewComposeLogsModel(
		ComposeLogsTitle{Name: "x", ImageTag: "v0", Mode: "local"},
		[]string{"tls-smtps"},
	)
	m = step(m, BridgeProbeResultMsg{Name: "tls-smtps", Status: "pending"})
	m = step(m, BridgeProbeResultMsg{Name: "tls-smtps", Status: "pass", Detail: "ok"})

	if got := len(m.Probes()); got != 1 {
		t.Fatalf("want 1 probe row after replace, got %d", got)
	}
	if got := m.Probes()[0].Status; got != "pass" {
		t.Fatalf("probe status not replaced: got %q", got)
	}
}

// TestComposeLogsModel_SanitisesAnsiEscapes ensures the ANSI escape
// strip in sanitize() is wired up — docker logs commonly include
// colour codes that would otherwise scribble over the layout.
func TestComposeLogsModel_SanitisesAnsiEscapes(t *testing.T) {
	m := NewComposeLogsModel(
		ComposeLogsTitle{Name: "x", ImageTag: "v0", Mode: "local"},
		nil,
	)
	m = step(m, tea.WindowSizeMsg{Width: 80, Height: 24})
	m = step(m, ComposeLogLineMsg{Line: "\x1b[31merror\x1b[0m something happened"})
	if got := m.Logs()[0]; strings.Contains(got, "\x1b") {
		t.Fatalf("ANSI escape leaked through sanitize: %q", got)
	}
}
