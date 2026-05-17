package domains

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
	byID map[string]client.Domain
	t    *theme.Theme
}

func New(ds datasource.Datasource, th *theme.Theme) *Tab {
	t := &Tab{ds: ds, t: th, byID: map[string]client.Domain{}}
	t.pane = listpane.New(th)
	t.pane.TabID = "domains"
	t.pane.Title = "Domains"
	t.pane.Interval = 60 * time.Second
	t.pane.Fetch = t.fetch
	t.pane.Render = t.render
	return t
}

func (t *Tab) Init() tea.Cmd                  { return nil }
func (t *Tab) ID() string                     { return "domains" }
func (t *Tab) Title() string                  { return "Domains" }
func (t *Tab) ShortKey() string               { return "3" }
func (t *Tab) RefreshInterval() time.Duration { return 60 * time.Second }
func (t *Tab) Refresh() tea.Cmd               { return t.pane.Refresh() }
func (t *Tab) Resize(w, h int)                { t.pane.Resize(w, h) }
func (t *Tab) Keybindings() []key.Binding     { return t.pane.Keybindings() }

func (t *Tab) Focus(p *polling.Poller) tea.Cmd {
	p.Update(polling.RegisterMsg{Job: t.pane.PollJob()})
	return t.pane.Refresh()
}
func (t *Tab) Blur(p *polling.Poller) tea.Cmd {
	p.Update(polling.PauseMsg{ID: polling.JobID("domains.list")})
	return nil
}

func (t *Tab) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	_, cmd := t.pane.Update(msg)
	return t, cmd
}
func (t *Tab) View() string { return t.pane.View() }

func (t *Tab) fetch(ctx context.Context) ([]listpane.Row, []string, error) {
	domains, err := t.ds.Domains(ctx)
	if err != nil {
		return nil, nil, err
	}
	rows := make([]listpane.Row, 0, len(domains))
	t.byID = map[string]client.Domain{}
	for _, d := range domains {
		t.byID[d.ID] = d
		rows = append(rows, listpane.Row{
			ID: d.ID,
			Display: []string{d.Name, d.Status, boolStr(d.InboundEnabled), boolStr(d.OutboundEnabled)},
		})
	}
	return rows, []string{"NAME", "STATUS", "IN", "OUT"}, nil
}

func (t *Tab) render(id string) string {
	d, ok := t.byID[id]
	if !ok {
		return t.t.Muted.Render("(no such domain)")
	}
	return listpane.JoinKV(t.t, [][2]string{
		{"id", d.ID},
		{"name", d.Name},
		{"status", d.Status},
		{"inbound", fmt.Sprintf("%v", d.InboundEnabled)},
		{"outbound", fmt.Sprintf("%v", d.OutboundEnabled)},
		{"wildcard", fmt.Sprintf("%v", d.WildcardSubdomains)},
		{"created", d.CreatedAt.Format(time.RFC3339)},
	})
}

func boolStr(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}
