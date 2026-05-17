package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/table"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// ComposeState is the high-level state machine the compose-logs view
// tracks. The cobra leaf transitions through these states by sending
// ComposeStateMsg as the underlying workflow progresses.
type ComposeState string

const (
	// ComposeStateUpStarting is the initial state — `docker compose up
	// -d` was issued and the view is tailing logs while the container
	// settles.
	ComposeStateUpStarting ComposeState = "up-starting"
	// ComposeStateVerifying is set once the descriptor's PostUpProbes
	// have begun running; the bottom panel populates row-by-row.
	ComposeStateVerifying ComposeState = "verifying"
	// ComposeStateHealthy is set when every required probe passes.
	ComposeStateHealthy ComposeState = "healthy"
	// ComposeStateFailed is set when any required probe fails or the
	// caller-supplied timeout elapses before all probes finish.
	ComposeStateFailed ComposeState = "failed"
	// ComposeStateDone is the terminal state — the model exits next
	// frame.
	ComposeStateDone ComposeState = "done"
)

// ComposeLogLineMsg is one line read from `docker compose logs -f`
// (stdout or stderr — the producer merges the two before sending).
type ComposeLogLineMsg struct{ Line string }

// ComposeStateMsg signals a high-level state transition.
type ComposeStateMsg struct{ State ComposeState }

// BridgeProbeResultMsg is one result row for the bottom probe panel.
// Status is one of "pass" | "fail" | "skip" | "pending" — the model
// up-cases for display.
type BridgeProbeResultMsg struct {
	Name   string
	Status string
	Detail string
}

// ComposeLogsTitle bundles the title-bar metadata so the cobra leaf can
// stamp the bridge name + image tag + deployment mode without leaking
// bridge-specific fields into the TUI surface.
type ComposeLogsTitle struct {
	Name     string // e.g. "edge-eu1"
	ImageTag string // e.g. "v1.4.2"
	Mode     string // e.g. "local" or "tailscale"
}

// ComposeLogsModel is a Bubble Tea Model that tails `docker compose
// logs -f` while a sibling goroutine runs post-up health probes. It
// is intentionally separate from tui.Model so the two concerns stay
// loosely coupled — both share the bubbles/viewport + lipgloss style
// language, nothing more.
type ComposeLogsModel struct {
	vp        viewport.Model
	tbl       table.Model
	spinner   spinner.Model
	title     ComposeLogsTitle
	probes    []BridgeProbeResultMsg
	logs      []string // bounded ring buffer (last N lines)
	maxLogs   int
	state     ComposeState
	width     int
	height    int
	err       error
	finished  bool // true once we have sent tea.Quit
	probeKeys []string
}

// NewComposeLogsModel constructs the model. probeNames is the ordered
// list of probes the descriptor will run — they're pre-seeded as
// "PENDING" rows so the operator sees the full list immediately.
func NewComposeLogsModel(title ComposeLogsTitle, probeNames []string) ComposeLogsModel {
	cols := []table.Column{
		{Title: "PROBE", Width: 18},
		{Title: "STATUS", Width: 10},
		{Title: "DETAIL", Width: 50},
	}
	tbl := table.New(
		table.WithColumns(cols),
		table.WithFocused(false),
		table.WithHeight(maxProbeHeight(len(probeNames))),
	)
	st := table.DefaultStyles()
	st.Header = st.Header.
		BorderStyle(lipgloss.NormalBorder()).
		BorderForeground(lipgloss.Color("240")).
		BorderBottom(true).
		Bold(true)
	tbl.SetStyles(st)

	sp := spinner.New()
	sp.Spinner = spinner.Dot
	sp.Style = lipgloss.NewStyle().Foreground(lipgloss.Color("205"))

	vp := viewport.New(80, 14)
	vp.SetContent("")

	probes := make([]BridgeProbeResultMsg, 0, len(probeNames))
	for _, n := range probeNames {
		probes = append(probes, BridgeProbeResultMsg{Name: n, Status: "pending"})
	}

	m := ComposeLogsModel{
		vp:        vp,
		tbl:       tbl,
		spinner:   sp,
		title:     title,
		probes:    probes,
		maxLogs:   1000,
		state:     ComposeStateUpStarting,
		probeKeys: append([]string(nil), probeNames...),
	}
	m.refreshTable()
	return m
}

// Init implements tea.Model.
func (m ComposeLogsModel) Init() tea.Cmd { return m.spinner.Tick }

// Update implements tea.Model.
func (m ComposeLogsModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch v := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = v.Width
		m.height = v.Height
		footerHeight := 2
		probeHeight := maxProbeHeight(len(m.probes)) + 2 // table + header border
		vpHeight := v.Height - probeHeight - footerHeight - 3
		if vpHeight < 4 {
			vpHeight = 4
		}
		m.vp.Width = v.Width
		m.vp.Height = vpHeight
		m.refreshContent()
		return m, nil
	case tea.KeyMsg:
		switch v.String() {
		case "q", "ctrl+c", "esc":
			return m, tea.Quit
		}
		var cmd tea.Cmd
		m.vp, cmd = m.vp.Update(msg)
		return m, cmd
	case ComposeLogLineMsg:
		m.appendLog(v.Line)
		m.refreshContent()
		return m, nil
	case ComposeStateMsg:
		m.state = v.State
		if v.State == ComposeStateDone || v.State == ComposeStateFailed {
			m.finished = true
			return m, tea.Quit
		}
		return m, nil
	case BridgeProbeResultMsg:
		m.updateProbe(v)
		return m, nil
	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd
	}
	return m, nil
}

// View implements tea.Model.
func (m ComposeLogsModel) View() string {
	if m.err != nil {
		return fmt.Sprintf("compose-logs error: %v\n", m.err)
	}
	titleStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("39"))
	dimStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("241"))
	header := titleStyle.Render(fmt.Sprintf("polaris-email — bridge up · %s", m.title.Name))
	subline := dimStyle.Render(fmt.Sprintf("image %s · mode %s · q to quit", m.title.ImageTag, m.title.Mode))
	sep := lipgloss.NewStyle().Foreground(lipgloss.Color("240")).Render(strings.Repeat("─", maxInt(20, m.width-1)))

	footer := m.footerLine()
	return strings.Join([]string{
		header,
		subline,
		sep,
		m.vp.View(),
		sep,
		m.tbl.View(),
		footer,
	}, "\n")
}

// State returns the current high-level state. Exposed for tests.
func (m ComposeLogsModel) State() ComposeState { return m.state }

// Logs returns the captured log lines. Exposed for tests; the caller
// should not mutate the returned slice.
func (m ComposeLogsModel) Logs() []string { return m.logs }

// Probes returns the current probe table. Exposed for tests.
func (m ComposeLogsModel) Probes() []BridgeProbeResultMsg { return m.probes }

// Finished reports whether the model has signalled tea.Quit. Exposed
// for tests — production code observes the terminal state via the
// tea.Program returning from Run().
func (m ComposeLogsModel) Finished() bool { return m.finished }

func (m *ComposeLogsModel) appendLog(line string) {
	line = sanitize(line)
	m.logs = append(m.logs, line)
	if len(m.logs) > m.maxLogs {
		// Drop the oldest 10% in one shot to amortise the slice reslice.
		drop := m.maxLogs / 10
		if drop < 1 {
			drop = 1
		}
		m.logs = m.logs[drop:]
	}
}

func (m *ComposeLogsModel) refreshContent() {
	m.vp.SetContent(strings.Join(m.logs, "\n"))
	m.vp.GotoBottom()
}

func (m *ComposeLogsModel) updateProbe(res BridgeProbeResultMsg) {
	// Match by name; insert at the end if the descriptor sent a probe
	// not pre-declared at construction. This keeps the surface defensive
	// against re-ordering bugs.
	for i, p := range m.probes {
		if p.Name == res.Name {
			m.probes[i] = res
			m.refreshTable()
			return
		}
	}
	m.probes = append(m.probes, res)
	m.refreshTable()
}

func (m *ComposeLogsModel) refreshTable() {
	rows := make([]table.Row, len(m.probes))
	for i, p := range m.probes {
		rows[i] = table.Row{p.Name, strings.ToUpper(p.Status), sanitize(p.Detail)}
	}
	m.tbl.SetRows(rows)
}

func (m ComposeLogsModel) footerLine() string {
	switch m.state {
	case ComposeStateUpStarting:
		return fmt.Sprintf("  %s starting container…", m.spinner.View())
	case ComposeStateVerifying:
		return fmt.Sprintf("  %s running post-up probes…", m.spinner.View())
	case ComposeStateHealthy:
		return lipgloss.NewStyle().Foreground(lipgloss.Color("42")).Render("  ✓ all probes passed — press q to dismiss")
	case ComposeStateFailed:
		return lipgloss.NewStyle().Foreground(lipgloss.Color("196")).Render("  ✗ a probe failed or timed out — press q to dismiss")
	case ComposeStateDone:
		return lipgloss.NewStyle().Foreground(lipgloss.Color("42")).Render("  ✓ done")
	}
	return ""
}

// maxProbeHeight sizes the bubbles/table viewport to fit n rows. The
// table reserves one line for the header + bottom border, so we add a
// constant of 1 to the row count. A floor of 5 prevents the table from
// shrinking below a comfortable size for empty/sparse probe sets; a
// ceiling of 12 keeps very large probe sets from dominating the screen.
func maxProbeHeight(n int) int {
	base := n + 1
	if base < 5 {
		return 5
	}
	if base > 12 {
		return 12
	}
	return base
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
