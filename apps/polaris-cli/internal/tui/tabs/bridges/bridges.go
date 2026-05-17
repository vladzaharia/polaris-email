package bridges

import (
	"context"
	"fmt"
	"time"

	"github.com/charmbracelet/bubbles/key"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/tui/datasource"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/tui/polling"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/tui/tabs/listpane"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/tui/theme"
)

type Tab struct {
	ds   datasource.Datasource
	pane *listpane.Model
	byID map[string]client.Bridge
	t    *theme.Theme
}

func New(ds datasource.Datasource, th *theme.Theme) *Tab {
	t := &Tab{ds: ds, t: th, byID: map[string]client.Bridge{}}
	t.pane = listpane.New(th)
	t.pane.TabID = "bridges"
	t.pane.Title = "Bridges"
	t.pane.Interval = 30 * time.Second
	t.pane.Fetch = t.fetch
	t.pane.Render = t.render
	return t
}

func (t *Tab) Init() tea.Cmd                  { return nil }
func (t *Tab) ID() string                     { return "bridges" }
func (t *Tab) Title() string                  { return "Bridges" }
func (t *Tab) ShortKey() string               { return "6" }
func (t *Tab) RefreshInterval() time.Duration { return 30 * time.Second }
func (t *Tab) Refresh() tea.Cmd               { return t.pane.Refresh() }
func (t *Tab) Resize(w, h int)                { t.pane.Resize(w, h) }
func (t *Tab) Keybindings() []key.Binding     { return t.pane.Keybindings() }

func (t *Tab) Focus(p *polling.Poller) tea.Cmd {
	p.Update(polling.RegisterMsg{Job: t.pane.PollJob()})
	return t.pane.Refresh()
}
func (t *Tab) Blur(p *polling.Poller) tea.Cmd {
	p.Update(polling.PauseMsg{ID: polling.JobID("bridges.list")})
	return nil
}

func (t *Tab) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	_, cmd := t.pane.Update(msg)
	return t, cmd
}
func (t *Tab) View() string { return t.pane.View() }

func (t *Tab) fetch(ctx context.Context) ([]listpane.Row, []string, error) {
	bridges, err := t.ds.Bridges(ctx)
	if err != nil {
		return nil, nil, err
	}
	t.byID = map[string]client.Bridge{}
	rows := make([]listpane.Row, 0, len(bridges))
	for _, b := range bridges {
		t.byID[b.ID] = b
		seen := "never"
		if b.LastSeenAt != nil {
			seen = time.Since(*b.LastSeenAt).Truncate(time.Second).String() + " ago"
		}
		disabled := "no"
		if b.DisabledAt != nil {
			disabled = "yes"
		}
		rows = append(rows, listpane.Row{
			ID: b.ID,
			Display: []string{b.Name, b.Environment, seen, disabled},
		})
	}
	return rows, []string{"NAME", "ENV", "LAST_SEEN", "DISABLED"}, nil
}

func (t *Tab) render(id string) string {
	b, ok := t.byID[id]
	if !ok {
		return t.t.Muted.Render("(no such bridge)")
	}
	seen := "never"
	if b.LastSeenAt != nil {
		seen = b.LastSeenAt.Format(time.RFC3339)
	}
	return listpane.JoinKV(t.t, [][2]string{
		{"id", b.ID},
		{"name", b.Name},
		{"environment", b.Environment},
		{"last seen", seen},
		{"created", b.CreatedAt.Format(time.RFC3339)},
		{"disabled", fmt.Sprintf("%v", b.DisabledAt != nil)},
	})
}
