package mailboxes

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
	byID map[string]datasource.Mailbox
	t    *theme.Theme
}

func New(ds datasource.Datasource, th *theme.Theme) *Tab {
	t := &Tab{ds: ds, t: th, byID: map[string]datasource.Mailbox{}}
	t.pane = listpane.New(th)
	t.pane.TabID = "mailboxes"
	t.pane.Title = "Mailboxes"
	t.pane.Interval = 30 * time.Second
	t.pane.Fetch = t.fetch
	t.pane.Render = t.render
	return t
}

func (t *Tab) Init() tea.Cmd                  { return nil }
func (t *Tab) ID() string                     { return "mailboxes" }
func (t *Tab) Title() string                  { return "Mailboxes" }
func (t *Tab) ShortKey() string               { return "2" }
func (t *Tab) RefreshInterval() time.Duration { return 30 * time.Second }
func (t *Tab) Refresh() tea.Cmd               { return t.pane.Refresh() }
func (t *Tab) Resize(w, h int)                { t.pane.Resize(w, h) }
func (t *Tab) Keybindings() []key.Binding     { return t.pane.Keybindings() }

func (t *Tab) Focus(p *polling.Poller) tea.Cmd {
	p.Update(polling.RegisterMsg{Job: t.pane.PollJob()})
	return t.pane.Refresh()
}
func (t *Tab) Blur(p *polling.Poller) tea.Cmd {
	p.Update(polling.PauseMsg{ID: polling.JobID("mailboxes.list")})
	return nil
}

func (t *Tab) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	_, cmd := t.pane.Update(msg)
	return t, cmd
}
func (t *Tab) View() string { return t.pane.View() }

func (t *Tab) fetch(ctx context.Context) ([]listpane.Row, []string, error) {
	mbs, err := t.ds.Mailboxes(ctx)
	if err != nil {
		return nil, nil, err
	}
	rows := make([]listpane.Row, 0, len(mbs))
	t.byID = map[string]datasource.Mailbox{}
	for _, m := range mbs {
		t.byID[m.ID] = m
		disabled := "no"
		if m.DisabledAt != nil {
			disabled = "yes"
		}
		rows = append(rows, listpane.Row{
			ID: m.ID,
			Display: []string{
				m.ID, m.Name, m.CreatedAt.Format("2006-01-02"), disabled,
			},
		})
	}
	return rows, []string{"ID", "NAME", "CREATED", "DISABLED"}, nil
}

func (t *Tab) render(id string) string {
	m, ok := t.byID[id]
	if !ok {
		return t.t.Muted.Render("(no such mailbox)")
	}
	return listpane.JoinKV(t.t, [][2]string{
		{"id", m.ID},
		{"name", m.Name},
		{"description", m.Description},
		{"created", m.CreatedAt.Format(time.RFC3339)},
		{"updated", m.UpdatedAt.Format(time.RFC3339)},
		{"disabled", fmt.Sprintf("%v", m.DisabledAt != nil)},
	})
}
