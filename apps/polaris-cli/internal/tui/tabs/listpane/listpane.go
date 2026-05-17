// Package listpane is a reusable "table + detail viewport" model that backs
// the Mailboxes, Domains, Credentials, Webhooks/DLQ, Bridges, and Audit tabs.
//
// Each consumer tab supplies:
//   - a `Fetcher` returning rows + table column specs
//   - a `Renderer` that turns the selected row id into a multi-line detail string
//
// This keeps each tab file <200 lines and makes the polling lifecycle uniform.
package listpane

import (
	"context"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/table"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/tui/polling"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/tui/theme"
)

// Row is one table row.
type Row struct {
	ID      string
	Display []string
}

// Fetcher fetches the current rows + column headers.
type Fetcher func(ctx context.Context) ([]Row, []string, error)

// Renderer renders the detail pane for the selected row id.
type Renderer func(id string) string

// Result is the polling-result message produced by a Fetcher.
type Result struct {
	TabID    string
	Rows     []Row
	Headers  []string
	Err      error
	FetchedAt time.Time
}

// Model is the reusable list+detail tab body.
type Model struct {
	TabID    string
	Title    string
	Theme    *theme.Theme
	Interval time.Duration

	Fetch  Fetcher
	Render Renderer

	table    table.Model
	detail   viewport.Model
	rows     []Row
	headers  []string
	lastErr  error
	lastOK   time.Time
	width    int
	height   int
}

// New constructs a Model. Theme is required; everything else is configured
// before the model is mounted.
func New(t *theme.Theme) *Model {
	tbl := table.New(table.WithFocused(true), table.WithHeight(10))
	vp := viewport.New(40, 10)
	return &Model{table: tbl, detail: vp, Theme: t}
}

func (m *Model) Init() tea.Cmd { return nil }

// Refresh returns a Cmd that re-fires the Fetcher.
func (m *Model) Refresh() tea.Cmd {
	if m.Fetch == nil {
		return nil
	}
	tabID := m.TabID
	fn := m.Fetch
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		rows, hdrs, err := fn(ctx)
		return Result{TabID: tabID, Rows: rows, Headers: hdrs, Err: err, FetchedAt: time.Now()}
	}
}

// PollJob returns the polling.Job descriptor for the AppModel scheduler.
func (m *Model) PollJob() polling.Job {
	return polling.Job{
		ID:       polling.JobID(m.TabID + ".list"),
		OwnerTab: m.TabID,
		Interval: m.Interval,
		Fetch: func(ctx context.Context) tea.Msg {
			rows, hdrs, err := m.Fetch(ctx)
			return Result{TabID: m.TabID, Rows: rows, Headers: hdrs, Err: err, FetchedAt: time.Now()}
		},
	}
}

// Update handles list-pane messages.
func (m *Model) Update(msg tea.Msg) (*Model, tea.Cmd) {
	switch x := msg.(type) {
	case Result:
		if x.TabID != m.TabID {
			return m, nil
		}
		if x.Err != nil {
			m.lastErr = x.Err
		} else {
			m.lastErr = nil
			m.lastOK = x.FetchedAt
			m.rows = x.Rows
			m.headers = x.Headers
			m.applyTable()
			m.applyDetail()
		}
		return m, nil
	case tea.KeyMsg:
		// Pass arrow keys / page keys through to either the table or the
		// detail viewport — depending on whether shift is held.
		var tcmd, vcmd tea.Cmd
		m.table, tcmd = m.table.Update(msg)
		m.detail, vcmd = m.detail.Update(msg)
		m.applyDetail()
		return m, tea.Batch(tcmd, vcmd)
	}
	return m, nil
}

// View renders the split pane.
func (m *Model) View() string {
	left := lipgloss.NewStyle().Width(m.leftWidth()).Render(m.table.View())
	right := lipgloss.NewStyle().Width(m.rightWidth()).Render(m.detail.View())
	body := lipgloss.JoinHorizontal(lipgloss.Top, left, right)

	header := m.Theme.Title.Render(m.Title)
	if m.lastErr != nil {
		header += "  " + m.Theme.Danger.Render("error: "+m.lastErr.Error())
	} else if !m.lastOK.IsZero() {
		header += "  " + m.Theme.Muted.Render("refreshed "+time.Since(m.lastOK).Truncate(time.Second).String()+" ago")
	}
	return lipgloss.JoinVertical(lipgloss.Left, header, body)
}

// Resize re-lays the split.
func (m *Model) Resize(w, h int) {
	m.width, m.height = w, h
	m.table.SetHeight(h - 2)
	m.detail.Width = m.rightWidth()
	m.detail.Height = h - 2
	m.applyTable()
}

// SelectedID returns the id of the focused row.
func (m *Model) SelectedID() string {
	r := m.table.SelectedRow()
	if len(r) == 0 {
		return ""
	}
	return r[0]
}

// Keybindings exposes the table's own bindings for the help overlay.
func (m *Model) Keybindings() []key.Binding {
	return []key.Binding{
		key.NewBinding(key.WithKeys("up", "k"), key.WithHelp("↑/k", "up")),
		key.NewBinding(key.WithKeys("down", "j"), key.WithHelp("↓/j", "down")),
	}
}

func (m *Model) leftWidth() int  { return max(40, m.width*5/12) }
func (m *Model) rightWidth() int { return max(20, m.width-m.leftWidth()-2) }

func (m *Model) applyTable() {
	if len(m.headers) == 0 {
		return
	}
	cols := make([]table.Column, len(m.headers))
	available := m.leftWidth() - 2
	colW := available / len(m.headers)
	if colW < 8 {
		colW = 8
	}
	for i, h := range m.headers {
		cols[i] = table.Column{Title: h, Width: colW}
	}
	m.table.SetColumns(cols)
	rows := make([]table.Row, 0, len(m.rows))
	for _, r := range m.rows {
		row := make(table.Row, len(m.headers))
		for i := 0; i < len(m.headers); i++ {
			if i < len(r.Display) {
				row[i] = trim(r.Display[i], colW-1)
			}
		}
		rows = append(rows, row)
	}
	m.table.SetRows(rows)
}

func (m *Model) applyDetail() {
	if m.Render == nil {
		m.detail.SetContent("")
		return
	}
	id := m.SelectedID()
	if id == "" {
		m.detail.SetContent(m.Theme.Muted.Render("(no row selected)"))
		return
	}
	m.detail.SetContent(m.Render(id))
}

func trim(s string, w int) string {
	if w <= 0 {
		return ""
	}
	if len([]rune(s)) <= w {
		return s
	}
	rs := []rune(s)
	return string(rs[:w-1]) + "…"
}

// JoinKV renders a list of (label, value) into the detail pane.
func JoinKV(t *theme.Theme, pairs [][2]string) string {
	var b strings.Builder
	for _, p := range pairs {
		b.WriteString(t.Muted.Render(p[0] + ":"))
		b.WriteString(" ")
		b.WriteString(p[1])
		b.WriteByte('\n')
	}
	return b.String()
}
