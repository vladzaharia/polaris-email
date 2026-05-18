// Package upgradenotice renders the bottom-of-screen infobox the TUI
// shows during a polaris-email self-upgrade.
//
// Two-phase progress:
//   - Download: bar fills 0% -> 100% as bytes arrive. Status text reads
//     "Downloading polaris-email v0.1.1…".
//   - Restart countdown: bar reverses 100% -> 0% over 10 seconds. Status
//     text reads "Restarting in Ns… (Enter to restart now, Esc to
//     cancel)".
//
// The TUI parent embeds Model as an optional field. When non-nil it
// displaces the status bar in the layout; on RestartTriggerMsg the
// parent calls upgrader.ReExec().
package upgradenotice

import (
	"fmt"
	"time"

	"github.com/charmbracelet/bubbles/progress"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/upgrader"
)

// Phase tracks which of the two visual states the infobox is in.
type Phase int

const (
	PhaseIdle Phase = iota
	PhaseDownloading
	PhaseRestarting
	PhaseCancelled
	PhaseFailed
)

// restartCountdownSeconds is how long we leave the operator to read the
// "upgrade complete" notice before relaunching. 10s matches the plan.
const restartCountdownSeconds = 10

// Model is the embeddable Bubble. Parent owns lifecycle: it constructs
// New(), feeds tea.Msgs into Update, and calls View to render the
// bottom strip.
type Model struct {
	progress       progress.Model
	width          int
	phase          Phase
	targetVersion  string
	currentVersion string
	bytesDone      int64
	bytesTotal     int64
	failureMessage string
	// secondsLeft counts down the restart timer. 0 → trigger restart.
	secondsLeft int
}

// New constructs an Idle-phase Model. width=0 is acceptable — the
// parent will send a WindowSizeMsg before the first View call.
func New() Model {
	p := progress.New(progress.WithGradient(peachA, peachB))
	p.ShowPercentage = true
	return Model{
		progress: p,
		phase:    PhaseIdle,
	}
}

// Catppuccin macchiato Peach gradient endpoints. The lipgloss
// "WithGradient" expects two hex strings; the inner bar fades between
// them as percent grows.
const (
	peachA = "#f5a97f"
	peachB = "#ee99a0" // rose, the next-shade-warmer in macchiato
)

// Active returns true when the infobox is visible (anything except
// Idle / Cancelled). The TUI parent uses this to decide whether to
// displace the status bar.
func (m Model) Active() bool {
	return m.phase != PhaseIdle && m.phase != PhaseCancelled
}

// SetWidth is called from the parent's WindowSizeMsg handler.
func (m *Model) SetWidth(w int) {
	m.width = w
	m.progress.Width = w - 6 // leave 6 cells for border + padding
}

// StartMsg flips the infobox from Idle to Downloading. Sent by the
// parent's background-upgrade-check goroutine when an Update is
// detected.
type StartMsg struct {
	CurrentVersion string
	TargetVersion  string
}

// ProgressMsg is a passthrough of upgrader.Progress events. The
// parent's goroutine forwards each Progress callback through
// prog.Send(ProgressMsg{...}).
type ProgressMsg upgrader.Progress

// InstalledMsg flips the infobox to Restarting + starts the
// countdown. Sent by the parent when upgrader.Install returns nil
// (the new binary is on disk and ready to exec).
type InstalledMsg struct{}

// FailedMsg flips to PhaseFailed with the error text. The infobox
// stays visible until dismissed by Enter / Esc.
type FailedMsg struct{ Err error }

// tickMsg is the internal 1Hz timer that drives the restart countdown.
type tickMsg time.Time

// RestartTriggerMsg fires when the countdown hits 0 OR the operator
// pressed Enter. The TUI parent listens for this and calls
// upgrader.ReExec().
type RestartTriggerMsg struct{}

// Init returns a no-op cmd; the parent's lifecycle drives the model.
func (m Model) Init() tea.Cmd { return nil }

// Update routes Bubbletea messages. Keys are routed to the infobox
// ONLY while it's in PhaseRestarting (the TUI parent owns key routing
// during other phases — it lets every other key flow through to the
// active tab).
func (m Model) Update(msg tea.Msg) (Model, tea.Cmd) {
	switch t := msg.(type) {
	case StartMsg:
		m.phase = PhaseDownloading
		m.currentVersion = t.CurrentVersion
		m.targetVersion = t.TargetVersion
		return m, nil
	case ProgressMsg:
		if t.Stage == upgrader.StageDownload && t.BytesTotal > 0 {
			m.bytesDone = t.BytesDone
			m.bytesTotal = t.BytesTotal
			cmd := m.progress.SetPercent(float64(t.BytesDone) / float64(t.BytesTotal))
			return m, cmd
		}
		return m, nil
	case InstalledMsg:
		m.phase = PhaseRestarting
		m.secondsLeft = restartCountdownSeconds
		// Reset to 100% for the reverse animation.
		cmd1 := m.progress.SetPercent(1.0)
		return m, tea.Batch(cmd1, tickEvery())
	case FailedMsg:
		m.phase = PhaseFailed
		if t.Err != nil {
			m.failureMessage = t.Err.Error()
		}
		return m, nil
	case tickMsg:
		if m.phase != PhaseRestarting {
			return m, nil
		}
		m.secondsLeft--
		if m.secondsLeft <= 0 {
			return m, func() tea.Msg { return RestartTriggerMsg{} }
		}
		pct := float64(m.secondsLeft) / float64(restartCountdownSeconds)
		cmd1 := m.progress.SetPercent(pct)
		return m, tea.Batch(cmd1, tickEvery())
	case tea.KeyMsg:
		// Parent decides whether to route keys here. We only handle
		// Enter (restart now) and Esc (cancel countdown).
		if m.phase != PhaseRestarting {
			return m, nil
		}
		switch t.String() {
		case "enter":
			return m, func() tea.Msg { return RestartTriggerMsg{} }
		case "esc":
			m.phase = PhaseCancelled
			return m, nil
		}
	case progress.FrameMsg:
		// Bubbles progress emits FrameMsg internally for its animation
		// loop. Forward it back to the embedded model so the gradient
		// smoothly tweens.
		updated, cmd := m.progress.Update(t)
		if p, ok := updated.(progress.Model); ok {
			m.progress = p
		}
		return m, cmd
	}
	return m, nil
}

func tickEvery() tea.Cmd {
	return tea.Tick(time.Second, func(t time.Time) tea.Msg { return tickMsg(t) })
}

// View renders the orange-bordered infobox at the current width.
// Returns "" when Inactive — the parent should fall back to the
// regular status bar.
func (m Model) View() string {
	if !m.Active() {
		return ""
	}
	border := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color(peachA)).
		Padding(0, 1)
	if m.width > 4 {
		border = border.Width(m.width - 2)
	}
	var line1 string
	switch m.phase {
	case PhaseDownloading:
		line1 = fmt.Sprintf("Downloading polaris-email %s…", m.targetVersion)
	case PhaseRestarting:
		line1 = fmt.Sprintf("Upgrade complete — restarting in %ds (Enter to restart now, Esc to cancel)", m.secondsLeft)
	case PhaseFailed:
		line1 = "Upgrade failed: " + m.failureMessage
	}
	return border.Render(line1 + "\n" + m.progress.View())
}
