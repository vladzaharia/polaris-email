package audit

import (
	"context"
	"fmt"
	"time"

	"github.com/charmbracelet/bubbles/key"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/tui/datasource"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/tui/polling"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/tui/tabs/listpane"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/tui/theme"
)

type Tab struct {
	ds   datasource.Datasource
	pane *listpane.Model
	byID map[string]datasource.AuditEntry
	t    *theme.Theme
}

func New(ds datasource.Datasource, th *theme.Theme) *Tab {
	t := &Tab{ds: ds, t: th, byID: map[string]datasource.AuditEntry{}}
	t.pane = listpane.New(th)
	t.pane.TabID = "audit"
	t.pane.Title = "Audit log"
	t.pane.Interval = 30 * time.Second
	t.pane.Fetch = t.fetch
	t.pane.Render = t.render
	return t
}

func (t *Tab) Init() tea.Cmd                  { return nil }
func (t *Tab) ID() string                     { return "audit" }
func (t *Tab) Title() string                  { return "Audit" }
func (t *Tab) ShortKey() string               { return "7" }
func (t *Tab) RefreshInterval() time.Duration { return 30 * time.Second }
func (t *Tab) Refresh() tea.Cmd               { return t.pane.Refresh() }
func (t *Tab) Resize(w, h int)                { t.pane.Resize(w, h) }
func (t *Tab) Keybindings() []key.Binding     { return t.pane.Keybindings() }

func (t *Tab) Focus(p *polling.Poller) tea.Cmd {
	p.Update(polling.RegisterMsg{Job: t.pane.PollJob()})
	return t.pane.Refresh()
}
func (t *Tab) Blur(p *polling.Poller) tea.Cmd {
	p.Update(polling.PauseMsg{ID: polling.JobID("audit.list")})
	return nil
}

func (t *Tab) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	_, cmd := t.pane.Update(msg)
	return t, cmd
}
func (t *Tab) View() string { return t.pane.View() }

func (t *Tab) fetch(ctx context.Context) ([]listpane.Row, []string, error) {
	entries, err := t.ds.AuditEntries(ctx, 200)
	if err != nil {
		return nil, nil, err
	}
	t.byID = map[string]datasource.AuditEntry{}
	rows := make([]listpane.Row, 0, len(entries))
	for _, e := range entries {
		id := fmt.Sprintf("%d", e.ID)
		t.byID[id] = e
		rows = append(rows, listpane.Row{
			ID: id,
			Display: []string{id, e.At.Format("15:04:05"), e.Actor, e.Action, e.Target},
		})
	}
	return rows, []string{"ID", "TIME", "ACTOR", "ACTION", "TARGET"}, nil
}

func (t *Tab) render(id string) string {
	e, ok := t.byID[id]
	if !ok {
		return t.t.Muted.Render("(no such audit entry)")
	}
	return listpane.JoinKV(t.t, [][2]string{
		{"id", fmt.Sprintf("%d", e.ID)},
		{"actor", e.Actor},
		{"action", e.Action},
		{"target", e.Target},
		{"at", e.At.Format(time.RFC3339)},
	})
}
