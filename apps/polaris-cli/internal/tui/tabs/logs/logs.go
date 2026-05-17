// Logs tab — thin wrapper around the existing tui.Model + SSEStream so the
// 8-tab app can host the live admin log viewer without duplicating any of
// the SSE machinery.
package logs

import (
	"context"
	"time"

	"github.com/charmbracelet/bubbles/key"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
	itui "github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/tui"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/tui/polling"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/tui/theme"
)

type Tab struct {
	cli    *client.Client
	theme  *theme.Theme
	inner  itui.Model
	closer func()
	ctx    context.Context
	cancel context.CancelFunc
	active bool
	width  int
	height int
}

// New creates the logs tab. The HTTP client is reused as-is — the SSE stream
// reads from `/v1/admin/logs/stream?follow=true`.
func New(cli *client.Client, th *theme.Theme) *Tab {
	return &Tab{cli: cli, theme: th}
}

func (t *Tab) Init() tea.Cmd                  { return nil }
func (t *Tab) ID() string                     { return "logs" }
func (t *Tab) Title() string                  { return "Logs" }
func (t *Tab) ShortKey() string               { return "8" }
func (t *Tab) RefreshInterval() time.Duration { return 0 }
func (t *Tab) Refresh() tea.Cmd               { return nil }
func (t *Tab) Resize(w, h int)                { t.width, t.height = w, h }
func (t *Tab) Keybindings() []key.Binding {
	return []key.Binding{
		key.NewBinding(key.WithKeys("up", "k"), key.WithHelp("↑/k", "scroll")),
		key.NewBinding(key.WithKeys("down", "j"), key.WithHelp("↓/j", "scroll")),
	}
}

// Focus opens the SSE stream. Polling is not used for this tab; SSE keeps
// the stream alive until Blur.
func (t *Tab) Focus(_ *polling.Poller) tea.Cmd {
	t.ctx, t.cancel = context.WithCancel(context.Background())
	stream, closer, err := itui.SSEStream(t.ctx, t.cli, "all", "")
	if err != nil {
		return func() tea.Msg { return itui.StreamErrMsg{Err: err} }
	}
	t.closer = closer
	t.inner = itui.New("admin logs", stream)
	t.active = true
	return t.inner.Init()
}

// Blur cancels the stream cleanly.
func (t *Tab) Blur(_ *polling.Poller) tea.Cmd {
	t.active = false
	if t.cancel != nil {
		t.cancel()
	}
	if t.closer != nil {
		t.closer()
	}
	return nil
}

func (t *Tab) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	if !t.active {
		return t, nil
	}
	m, cmd := t.inner.Update(msg)
	if updated, ok := m.(itui.Model); ok {
		t.inner = updated
	}
	return t, cmd
}

func (t *Tab) View() string {
	if !t.active {
		return t.theme.Muted.Render("(opening log stream…)")
	}
	return t.inner.View()
}
