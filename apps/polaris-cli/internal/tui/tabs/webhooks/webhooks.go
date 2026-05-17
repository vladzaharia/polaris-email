// Webhooks/DLQ tab — top half lists webhook subscriptions, bottom half DLQ.
package webhooks

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
	ds      datasource.Datasource
	subs    *listpane.Model
	dlq     *listpane.Model
	subByID map[string]datasource.WebhookSub
	dlqByID map[string]client.WebhookDLQEntry
	t       *theme.Theme
	width   int
	height  int
	focus   int // 0 = subs, 1 = dlq
}

func New(ds datasource.Datasource, th *theme.Theme) *Tab {
	t := &Tab{
		ds: ds, t: th,
		subByID: map[string]datasource.WebhookSub{},
		dlqByID: map[string]client.WebhookDLQEntry{},
	}
	t.subs = listpane.New(th)
	t.subs.TabID = "webhooks.subs"
	t.subs.Title = "Subscriptions"
	t.subs.Interval = 30 * time.Second
	t.subs.Fetch = t.fetchSubs
	t.subs.Render = t.renderSub

	t.dlq = listpane.New(th)
	t.dlq.TabID = "webhooks.dlq"
	t.dlq.Title = "DLQ"
	t.dlq.Interval = 10 * time.Second
	t.dlq.Fetch = t.fetchDLQ
	t.dlq.Render = t.renderDLQ
	return t
}

func (t *Tab) Init() tea.Cmd                  { return nil }
func (t *Tab) ID() string                     { return "webhooks" }
func (t *Tab) Title() string                  { return "Webhooks/DLQ" }
func (t *Tab) ShortKey() string               { return "5" }
func (t *Tab) RefreshInterval() time.Duration { return 10 * time.Second }
func (t *Tab) Refresh() tea.Cmd {
	return tea.Batch(t.subs.Refresh(), t.dlq.Refresh())
}
func (t *Tab) Resize(w, h int) {
	t.width, t.height = w, h
	t.subs.Resize(w, h/2-1)
	t.dlq.Resize(w, h/2-1)
}
func (t *Tab) Keybindings() []key.Binding {
	return append(t.subs.Keybindings(),
		key.NewBinding(key.WithKeys("tab"), key.WithHelp("tab", "switch subs/DLQ")),
	)
}

func (t *Tab) Focus(p *polling.Poller) tea.Cmd {
	p.Update(polling.RegisterMsg{Job: t.subs.PollJob()})
	p.Update(polling.RegisterMsg{Job: t.dlq.PollJob()})
	return tea.Batch(t.subs.Refresh(), t.dlq.Refresh())
}
func (t *Tab) Blur(p *polling.Poller) tea.Cmd {
	p.Update(polling.PauseMsg{ID: polling.JobID("webhooks.subs.list")})
	p.Update(polling.PauseMsg{ID: polling.JobID("webhooks.dlq.list")})
	return nil
}

func (t *Tab) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	// Toggle focus on tab key.
	if km, ok := msg.(tea.KeyMsg); ok && km.String() == "tab" {
		t.focus ^= 1
		return t, nil
	}
	var c1, c2 tea.Cmd
	if t.focus == 0 {
		_, c1 = t.subs.Update(msg)
	} else {
		_, c2 = t.dlq.Update(msg)
	}
	// Always feed Result msgs to whichever pane they belong to (the listpane
	// guards against mis-routing internally).
	if _, ok := msg.(listpane.Result); ok {
		_, x := t.subs.Update(msg)
		_, y := t.dlq.Update(msg)
		c1 = x
		c2 = y
	}
	return t, tea.Batch(c1, c2)
}

func (t *Tab) View() string {
	top := t.subs.View()
	bot := t.dlq.View()
	if t.focus == 1 {
		bot = "▶ " + bot
	} else {
		top = "▶ " + top
	}
	return top + "\n\n" + bot
}

func (t *Tab) fetchSubs(ctx context.Context) ([]listpane.Row, []string, error) {
	subs, err := t.ds.WebhookSubs(ctx)
	if err != nil {
		return nil, nil, err
	}
	t.subByID = map[string]datasource.WebhookSub{}
	rows := make([]listpane.Row, 0, len(subs))
	for _, s := range subs {
		t.subByID[s.ID] = s
		paused := "no"
		if s.PausedAt != nil {
			paused = "yes"
		}
		rows = append(rows, listpane.Row{
			ID: s.ID,
			Display: []string{s.ID, s.Kind, trimURL(s.URL, 40), paused},
		})
	}
	return rows, []string{"ID", "KIND", "URL", "PAUSED"}, nil
}

func (t *Tab) fetchDLQ(ctx context.Context) ([]listpane.Row, []string, error) {
	dlq, err := t.ds.WebhookDLQ(ctx)
	if err != nil {
		return nil, nil, err
	}
	t.dlqByID = map[string]client.WebhookDLQEntry{}
	rows := make([]listpane.Row, 0, len(dlq))
	for _, e := range dlq {
		t.dlqByID[e.ID] = e
		rows = append(rows, listpane.Row{
			ID: e.ID,
			Display: []string{
				e.ID, fmt.Sprintf("%d", e.AttemptCount),
				fmt.Sprintf("%d", e.LastResponse),
				trimURL(e.URL, 40),
			},
		})
	}
	return rows, []string{"ID", "ATTEMPTS", "LAST_CODE", "URL"}, nil
}

func (t *Tab) renderSub(id string) string {
	s, ok := t.subByID[id]
	if !ok {
		return t.t.Muted.Render("(no such subscription)")
	}
	return listpane.JoinKV(t.t, [][2]string{
		{"id", s.ID},
		{"mailbox", s.MailboxID},
		{"url", s.URL},
		{"kind", s.Kind},
		{"events", fmt.Sprintf("%v", s.Events)},
		{"paused", fmt.Sprintf("%v", s.PausedAt != nil)},
		{"created", s.CreatedAt.Format(time.RFC3339)},
	})
}

func (t *Tab) renderDLQ(id string) string {
	e, ok := t.dlqByID[id]
	if !ok {
		return t.t.Muted.Render("(no such DLQ entry)")
	}
	return listpane.JoinKV(t.t, [][2]string{
		{"id", e.ID},
		{"webhook_sub", e.WebhookSubID},
		{"message_id", e.MessageID},
		{"url", e.URL},
		{"attempt count", fmt.Sprintf("%d", e.AttemptCount)},
		{"last error", e.LastError},
		{"first failed", e.FirstFailedAt.Format(time.RFC3339)},
		{"updated", e.UpdatedAt.Format(time.RFC3339)},
	})
}

func trimURL(u string, max int) string {
	if len(u) <= max {
		return u
	}
	return u[:max-1] + "…"
}
