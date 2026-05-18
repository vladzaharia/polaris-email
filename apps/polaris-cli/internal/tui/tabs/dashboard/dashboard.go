// Package dashboard renders the system-status overview that opens by default.
//
// Polls `dash.status` (5s), `dash.chain` (15s), `dash.bridges` (30s), and
// `dash.alerts` (30s). Accumulates a history ring per metric so sparklines
// have something to plot during a session.
package dashboard

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/NimbleMarkets/ntcharts/sparkline"
	"github.com/charmbracelet/bubbles/key"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/tui/datasource"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/tui/history"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/tui/polling"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/tui/theme"
)

// Tab is the Dashboard tab model.
type Tab struct {
	DS    datasource.Datasource
	Theme *theme.Theme

	width, height int

	status       *datasource.AdminStatusCounts
	chain        *datasource.AuditChainStatus
	bridges      []client.Bridge
	alerts       []datasource.Alert
	lastErr      error

	// Rings (capacity covers ~10 min at the relevant poll interval).
	dlqDepth *history.Ring[int]
}

// New constructs the tab.
func New(ds datasource.Datasource, t *theme.Theme) *Tab {
	return &Tab{
		DS:       ds,
		Theme:    t,
		dlqDepth: history.New[int](120),
	}
}

func (t *Tab) Init() tea.Cmd { return nil }
func (t *Tab) ID() string    { return "dashboard" }
func (t *Tab) Title() string { return "Dashboard" }
func (t *Tab) ShortKey() string {
	return "1"
}
func (t *Tab) RefreshInterval() time.Duration { return 5 * time.Second }
func (t *Tab) Resize(w, h int)                { t.width, t.height = w, h }
func (t *Tab) Keybindings() []key.Binding     { return nil }

// Refresh is called from the manual `r` key in the AppModel.
func (t *Tab) Refresh() tea.Cmd {
	return tea.Batch(t.statusCmd(), t.chainCmd(), t.bridgesCmd(), t.alertsCmd())
}

// Focus registers all polling jobs for this tab.
func (t *Tab) Focus(p *polling.Poller) tea.Cmd {
	p.Update(polling.RegisterMsg{Job: polling.Job{
		ID: "dash.status", OwnerTab: "dashboard", Interval: 5 * time.Second,
		Fetch: t.statusFetch,
	}})
	p.Update(polling.RegisterMsg{Job: polling.Job{
		ID: "dash.chain", OwnerTab: "dashboard", Interval: 15 * time.Second,
		Fetch: t.chainFetch,
	}})
	p.Update(polling.RegisterMsg{Job: polling.Job{
		ID: "dash.bridges", OwnerTab: "dashboard", Interval: 30 * time.Second,
		Fetch: t.bridgesFetch,
	}})
	p.Update(polling.RegisterMsg{Job: polling.Job{
		ID: "dash.alerts", OwnerTab: "dashboard", Interval: 30 * time.Second,
		Fetch: t.alertsFetch,
	}})
	return tea.Batch(
		t.statusCmd(), t.chainCmd(), t.bridgesCmd(), t.alertsCmd(),
	)
}

// Blur pauses polling.
func (t *Tab) Blur(p *polling.Poller) tea.Cmd {
	for _, id := range []polling.JobID{"dash.status", "dash.chain", "dash.bridges", "dash.alerts"} {
		p.Update(polling.PauseMsg{ID: id})
	}
	return nil
}

// Update routes polling results.
func (t *Tab) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch m := msg.(type) {
	case statusMsg:
		if m.Err != nil {
			t.lastErr = m.Err
			return t, nil
		}
		t.status = m.Data
		t.dlqDepth.Push(time.Now(), m.Data.WebhookDLQDepth)
		t.lastErr = nil
	case chainMsg:
		if m.Err == nil {
			t.chain = m.Data
		}
	case bridgesMsg:
		if m.Err == nil {
			t.bridges = m.Data
		}
	case alertsMsg:
		if m.Err == nil {
			t.alerts = m.Data
		}
	}
	return t, nil
}

// View renders the dashboard.
func (t *Tab) View() string {
	if t.width == 0 {
		return ""
	}
	title := t.Theme.Title.Render("System dashboard")
	if t.lastErr != nil {
		title += "  " + t.Theme.Danger.Render("⚠ "+t.lastErr.Error())
	}

	kpi := t.renderKPI()
	dlq := t.renderDLQ()
	chain := t.renderChain()
	br := t.renderBridges()
	al := t.renderAlerts()

	row1 := kpi
	row2 := lipgloss.JoinHorizontal(lipgloss.Top, dlq, "  ", chain)
	row3 := lipgloss.JoinHorizontal(lipgloss.Top, br, "  ", al)
	return lipgloss.JoinVertical(lipgloss.Left, title, "", row1, "", row2, "", row3)
}

func (t *Tab) renderKPI() string {
	if t.status == nil {
		return t.Theme.Muted.Render("loading status…")
	}
	mk := func(label string, n int, style lipgloss.Style) string {
		return lipgloss.JoinVertical(lipgloss.Left,
			style.Render(fmt.Sprintf("%d", n)),
			t.Theme.Muted.Render(label),
		)
	}
	row := []string{
		mk("mailboxes", t.status.Mailboxes, t.Theme.Title),
		mk("domains", t.status.Domains, t.Theme.Title),
		mk("bridges", t.status.Bridges, t.Theme.Title),
		mk("api keys", t.status.APIKeys, t.Theme.Title),
		mk("msgs / 24h", t.status.MessagesLast24h, t.Theme.Title),
		mk("dlq depth", t.status.WebhookDLQDepth, dlqStyle(t.Theme, t.status.WebhookDLQDepth)),
	}
	cells := make([]string, len(row))
	for i, c := range row {
		cells[i] = lipgloss.NewStyle().Width(15).Render(c)
	}
	return lipgloss.JoinHorizontal(lipgloss.Top, cells...)
}

func (t *Tab) renderDLQ() string {
	w := t.width/2 - 2
	if w < 20 {
		w = 20
	}
	s := sparkline.New(w, 5)
	for _, sample := range t.dlqDepth.Snapshot() {
		s.Push(float64(sample.V))
	}
	s.Draw()
	header := t.Theme.Subtitle.Render(fmt.Sprintf("DLQ depth (last %d samples)", t.dlqDepth.Len()))
	return lipgloss.JoinVertical(lipgloss.Left, header, s.View())
}

func (t *Tab) renderChain() string {
	if t.chain == nil {
		return t.Theme.Muted.Render("loading audit chain…")
	}
	if t.chain.Head.ID == 0 {
		return t.Theme.Muted.Render("audit log empty")
	}
	since := time.Since(time.UnixMilli(t.chain.Head.At))
	hdr := t.Theme.Subtitle.Render("Audit chain")
	body := []string{
		t.Theme.Muted.Render("head id:    ") + fmt.Sprintf("%d", t.chain.Head.ID),
		t.Theme.Muted.Render("row hash:   ") + truncMid(t.chain.Head.RowHash, 16),
		t.Theme.Muted.Render("last entry: ") + time.UnixMilli(t.chain.Head.At).Format(time.RFC3339),
		t.Theme.Muted.Render("freshness:  ") + freshnessStyle(t.Theme, since).Render(since.Truncate(time.Second).String()+" ago"),
	}
	return lipgloss.JoinVertical(lipgloss.Left, hdr, strings.Join(body, "\n"))
}

// truncMid returns "abcd…wxyz" for long strings, or s unchanged.
func truncMid(s string, keep int) string {
	if len(s) <= keep*2+1 {
		return s
	}
	return s[:keep] + "…" + s[len(s)-keep:]
}

func (t *Tab) renderBridges() string {
	hdr := t.Theme.Subtitle.Render("Bridges")
	if len(t.bridges) == 0 {
		return lipgloss.JoinVertical(lipgloss.Left, hdr, t.Theme.Muted.Render("(none)"))
	}
	rows := []string{hdr}
	for _, b := range t.bridges {
		dot := t.Theme.OK.Render("●")
		ago := "never"
		if b.LastSeenAt != nil {
			d := time.Since(*b.LastSeenAt)
			ago = d.Truncate(time.Second).String() + " ago"
			switch {
			case d > 5*time.Minute:
				dot = t.Theme.Danger.Render("●")
			case d > time.Minute:
				dot = t.Theme.Warn.Render("●")
			}
		} else {
			dot = t.Theme.Danger.Render("◌")
		}
		rows = append(rows, fmt.Sprintf("  %s %-20s %s", dot, b.Name, t.Theme.Muted.Render(ago)))
	}
	return lipgloss.JoinVertical(lipgloss.Left, rows...)
}

func (t *Tab) renderAlerts() string {
	hdr := t.Theme.Subtitle.Render("Recent alerts")
	if len(t.alerts) == 0 {
		return lipgloss.JoinVertical(lipgloss.Left, hdr, t.Theme.OK.Render("  ✓ no recent alerts"))
	}
	rows := []string{hdr}
	for _, a := range t.alerts {
		var sev lipgloss.Style
		switch a.Severity {
		case "critical":
			sev = t.Theme.Danger
		case "warn":
			sev = t.Theme.Warn
		default:
			sev = t.Theme.Info
		}
		rows = append(rows, fmt.Sprintf("  %s %s %s", sev.Render("["+a.Severity+"]"), a.Type, t.Theme.Muted.Render(a.Message)))
	}
	return lipgloss.JoinVertical(lipgloss.Left, rows...)
}

// ---- polling fetches ----

type (
	statusMsg  struct{ Data *datasource.AdminStatusCounts; Err error }
	chainMsg   struct{ Data *datasource.AuditChainStatus; Err error }
	bridgesMsg struct{ Data []client.Bridge; Err error }
	alertsMsg  struct{ Data []datasource.Alert; Err error }
)

func (t *Tab) statusFetch(ctx context.Context) tea.Msg {
	d, err := t.DS.AdminStatus(ctx)
	return statusMsg{Data: d, Err: err}
}
func (t *Tab) chainFetch(ctx context.Context) tea.Msg {
	d, err := t.DS.AuditChainStatus(ctx)
	return chainMsg{Data: d, Err: err}
}
func (t *Tab) bridgesFetch(ctx context.Context) tea.Msg {
	d, err := t.DS.Bridges(ctx)
	return bridgesMsg{Data: d, Err: err}
}
func (t *Tab) alertsFetch(ctx context.Context) tea.Msg {
	d, err := t.DS.Alerts(ctx, 5)
	return alertsMsg{Data: d, Err: err}
}

func (t *Tab) statusCmd() tea.Cmd  { return func() tea.Msg { return t.statusFetch(context.Background()) } }
func (t *Tab) chainCmd() tea.Cmd   { return func() tea.Msg { return t.chainFetch(context.Background()) } }
func (t *Tab) bridgesCmd() tea.Cmd { return func() tea.Msg { return t.bridgesFetch(context.Background()) } }
func (t *Tab) alertsCmd() tea.Cmd  { return func() tea.Msg { return t.alertsFetch(context.Background()) } }

func dlqStyle(th *theme.Theme, n int) lipgloss.Style {
	switch {
	case n >= 100:
		return th.Danger
	case n >= 10:
		return th.Warn
	default:
		return th.OK
	}
}

func freshnessStyle(th *theme.Theme, d time.Duration) lipgloss.Style {
	switch {
	case d > time.Hour:
		return th.Danger
	case d > 15*time.Minute:
		return th.Warn
	default:
		return th.OK
	}
}
