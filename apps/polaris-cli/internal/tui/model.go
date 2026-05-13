// Package tui holds the Bubble Tea views for the CLI.
package tui

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/table"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
)

// LogMsg is dispatched when a new log entry arrives over the stream.
type LogMsg struct{ Entry client.LogEntry }

// StreamErrMsg signals that the stream errored or ended.
type StreamErrMsg struct{ Err error }

// StreamFunc is the source of log entries. It returns a tea.Cmd that, when
// executed, reads exactly one entry (or returns StreamErrMsg).
type StreamFunc func() tea.Cmd

// Model is the Bubble Tea model for `logs --follow`.
type Model struct {
	tbl      table.Model
	vp       viewport.Model
	rows     []client.LogEntry
	stream   StreamFunc
	width    int
	height   int
	err      error
	maxRows  int
	titleBar string
}

// New constructs a model. Title is shown in the header (e.g., "logs send acme.com").
func New(title string, stream StreamFunc) Model {
	cols := []table.Column{
		{Title: "Time", Width: 19},
		{Title: "Type", Width: 8},
		{Title: "Domain", Width: 20},
		{Title: "Status", Width: 10},
		{Title: "Subject / Message", Width: 60},
	}
	t := table.New(
		table.WithColumns(cols),
		table.WithFocused(true),
		table.WithHeight(20),
	)
	st := table.DefaultStyles()
	st.Header = st.Header.BorderStyle(lipgloss.NormalBorder()).BorderBottom(true).Bold(true)
	st.Selected = st.Selected.Foreground(lipgloss.Color("229")).Background(lipgloss.Color("57")).Bold(true)
	t.SetStyles(st)

	vp := viewport.New(80, 6)
	return Model{
		tbl:      t,
		vp:       vp,
		stream:   stream,
		maxRows:  500,
		titleBar: title,
	}
}

func (m Model) Init() tea.Cmd {
	if m.stream == nil {
		return nil
	}
	return m.stream()
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		tableHeight := msg.Height - 10
		if tableHeight < 5 {
			tableHeight = 5
		}
		m.tbl.SetHeight(tableHeight)
		m.vp.Width = msg.Width
		m.vp.Height = 6
	case tea.KeyMsg:
		switch msg.String() {
		case "q", "ctrl+c", "esc":
			return m, tea.Quit
		}
	case LogMsg:
		m.appendEntry(msg.Entry)
		m.refreshDetail()
		if m.stream != nil {
			return m, m.stream()
		}
	case StreamErrMsg:
		m.err = msg.Err
		return m, tea.Quit
	}
	var cmd tea.Cmd
	m.tbl, cmd = m.tbl.Update(msg)
	m.refreshDetail()
	return m, cmd
}

func (m *Model) appendEntry(e client.LogEntry) {
	m.rows = append(m.rows, e)
	if len(m.rows) > m.maxRows {
		m.rows = m.rows[len(m.rows)-m.maxRows:]
	}
	rows := make([]table.Row, len(m.rows))
	for i, r := range m.rows {
		rows[i] = table.Row{
			r.Timestamp.Format(time.RFC3339),
			r.Type,
			r.Domain,
			r.Status,
			sanitize(firstNonEmpty(r.Subject, r.Message)),
		}
	}
	m.tbl.SetRows(rows)
	m.tbl.GotoBottom()
}

func (m *Model) refreshDetail() {
	idx := m.tbl.Cursor()
	if idx < 0 || idx >= len(m.rows) {
		m.vp.SetContent("")
		return
	}
	r := m.rows[idx]
	var sb strings.Builder
	fmt.Fprintf(&sb, "Time:    %s\n", r.Timestamp.Format(time.RFC3339Nano))
	fmt.Fprintf(&sb, "Type:    %s   Domain: %s   Tenant: %s\n", r.Type, r.Domain, r.Tenant)
	fmt.Fprintf(&sb, "Status:  %s\n", r.Status)
	if r.Subject != "" {
		fmt.Fprintf(&sb, "Subject: %s\n", sanitize(r.Subject))
	}
	if r.Message != "" {
		fmt.Fprintf(&sb, "Message: %s\n", sanitize(r.Message))
	}
	for k, v := range r.Fields {
		fmt.Fprintf(&sb, "  %s: %s\n", k, sanitize(v))
	}
	m.vp.SetContent(sb.String())
}

func (m Model) View() string {
	if m.err != nil {
		return fmt.Sprintf("stream error: %v\n", m.err)
	}
	header := lipgloss.NewStyle().Bold(true).Render(m.titleBar) + "  (q to quit)"
	return strings.Join([]string{
		header,
		m.tbl.View(),
		lipgloss.NewStyle().BorderTop(true).BorderStyle(lipgloss.NormalBorder()).Render(""),
		m.vp.View(),
	}, "\n")
}

func sanitize(s string) string {
	var sb strings.Builder
	skipping := false
	for _, r := range s {
		if r == 0x1b {
			skipping = true
			continue
		}
		if skipping {
			if r == 'm' {
				skipping = false
			}
			continue
		}
		if r < 0x20 && r != '\t' {
			sb.WriteByte(' ')
			continue
		}
		sb.WriteRune(r)
	}
	return sb.String()
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
