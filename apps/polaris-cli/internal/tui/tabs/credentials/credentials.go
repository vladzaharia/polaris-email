package credentials

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
	byID map[string]datasource.Credential
	t    *theme.Theme
}

func New(ds datasource.Datasource, th *theme.Theme) *Tab {
	t := &Tab{ds: ds, t: th, byID: map[string]datasource.Credential{}}
	t.pane = listpane.New(th)
	t.pane.TabID = "credentials"
	t.pane.Title = "Credentials"
	t.pane.Interval = 60 * time.Second
	t.pane.Fetch = t.fetch
	t.pane.Render = t.render
	return t
}

func (t *Tab) Init() tea.Cmd                  { return nil }
func (t *Tab) ID() string                     { return "credentials" }
func (t *Tab) Title() string                  { return "Credentials" }
func (t *Tab) ShortKey() string               { return "4" }
func (t *Tab) RefreshInterval() time.Duration { return 60 * time.Second }
func (t *Tab) Refresh() tea.Cmd               { return t.pane.Refresh() }
func (t *Tab) Resize(w, h int)                { t.pane.Resize(w, h) }
func (t *Tab) Keybindings() []key.Binding     { return t.pane.Keybindings() }

func (t *Tab) Focus(p *polling.Poller) tea.Cmd {
	p.Update(polling.RegisterMsg{Job: t.pane.PollJob()})
	return t.pane.Refresh()
}
func (t *Tab) Blur(p *polling.Poller) tea.Cmd {
	p.Update(polling.PauseMsg{ID: polling.JobID("credentials.list")})
	return nil
}

func (t *Tab) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	_, cmd := t.pane.Update(msg)
	return t, cmd
}
func (t *Tab) View() string { return t.pane.View() }

func (t *Tab) fetch(ctx context.Context) ([]listpane.Row, []string, error) {
	// Credentials list requires a mailbox filter. Without one, surface a
	// hint row so the empty pane explains itself.
	creds, err := t.ds.Credentials(ctx, "")
	if err != nil {
		return nil, nil, err
	}
	t.byID = map[string]datasource.Credential{}
	rows := make([]listpane.Row, 0, len(creds))
	for _, c := range creds {
		t.byID[c.ID] = c
		rows = append(rows, listpane.Row{
			ID: c.ID,
			Display: []string{c.ID, c.Kind, c.Status, c.CreatedAt.Format("2006-01-02")},
		})
	}
	return rows, []string{"ID", "KIND", "STATUS", "CREATED"}, nil
}

func (t *Tab) render(id string) string {
	c, ok := t.byID[id]
	if !ok {
		return t.t.Muted.Render("(no such credential)")
	}
	return listpane.JoinKV(t.t, [][2]string{
		{"id", c.ID},
		{"kind", c.Kind},
		{"status", c.Status},
		{"username", c.Username},
		{"principal id", c.PrincipalID},
		{"created", c.CreatedAt.Format(time.RFC3339)},
		{"disabled", fmt.Sprintf("%v", c.DisabledAt != nil)},
	})
}
