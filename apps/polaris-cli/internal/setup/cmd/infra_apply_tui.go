package cmd

import (
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"github.com/charmbracelet/bubbles/progress"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/provision"
)

// tuiReporter is a provision.Reporter that drives a Bubble Tea model
// running in a sibling goroutine. The reporter methods are called
// from the Apply() worker; they push typed messages onto a channel
// that the tea program drains.
//
// The model renders:
//
//   - polaris-mail — provisioning Cloudflare resources
//     ⠋ kv polaris-mail-nonce
//     [████████████░░░░░░░] 4/9
//     done: d1 polaris-mail
//     done: r2 polaris-mail
//     done: kv polaris-mail-idempotency
//
// Style matches the existing tui package (lipgloss bold headers,
// normal-border separators).
type tuiReporter struct {
	prog   *tea.Program
	wg     sync.WaitGroup
	closed sync.Once
}

// newTUIReporter constructs the reporter, kicks the tea program in a
// background goroutine, and returns a *tuiReporter. Close() must be
// called from the same goroutine that invoked newTUIReporter to flush
// the terminal cleanly.
//
// out is the output stream (usually os.Stdout). The reporter takes
// over the terminal for the duration of the run; the caller must not
// write to out concurrently.
func newTUIReporter(out io.Writer) *tuiReporter {
	m := newTUIModel()
	prog := tea.NewProgram(m, tea.WithOutput(out))
	r := &tuiReporter{prog: prog}
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		// We ignore the returned model + error: the cmd-level RunE
		// surfaces failures via the Apply() error, and a tea panic is
		// unrecoverable anyway.
		_, _ = prog.Run()
	}()
	return r
}

// Start implements provision.Reporter.
func (r *tuiReporter) Start(total int) {
	r.prog.Send(tuiStartMsg{total: total})
}

// Step implements provision.Reporter.
func (r *tuiReporter) Step(kind, name string) {
	r.prog.Send(tuiStepMsg{kind: kind, name: name})
}

// StepDone implements provision.Reporter.
func (r *tuiReporter) StepDone(kind, name string, err error) {
	r.prog.Send(tuiStepDoneMsg{kind: kind, name: name, err: err})
}

// Done implements provision.Reporter. It signals the tea program to
// quit and waits for the goroutine to flush the terminal.
func (r *tuiReporter) Done() {
	r.closed.Do(func() {
		r.prog.Send(tuiDoneMsg{})
		r.prog.Quit()
		r.wg.Wait()
	})
}

// --- Bubble Tea model --------------------------------------------------------

type tuiStartMsg struct{ total int }
type tuiStepMsg struct{ kind, name string }
type tuiStepDoneMsg struct {
	kind, name string
	err        error
}
type tuiDoneMsg struct{}

type tuiModel struct {
	spinner  spinner.Model
	progress progress.Model

	total       int
	completed   int
	currentKind string
	currentName string

	// history is the last N "done" lines we print above the spinner.
	history    []string
	maxHistory int

	headerStyle lipgloss.Style
	doneStyle   lipgloss.Style
	failStyle   lipgloss.Style
	dimStyle    lipgloss.Style

	finished bool
}

func newTUIModel() tuiModel {
	sp := spinner.New()
	sp.Spinner = spinner.Dot
	sp.Style = lipgloss.NewStyle().Foreground(lipgloss.Color("205"))

	pb := progress.New(progress.WithDefaultGradient())
	pb.Width = 40

	return tuiModel{
		spinner:     sp,
		progress:    pb,
		maxHistory:  10,
		headerStyle: lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("39")),
		doneStyle:   lipgloss.NewStyle().Foreground(lipgloss.Color("42")),
		failStyle:   lipgloss.NewStyle().Foreground(lipgloss.Color("196")).Bold(true),
		dimStyle:    lipgloss.NewStyle().Foreground(lipgloss.Color("241")),
	}
}

func (m tuiModel) Init() tea.Cmd { return m.spinner.Tick }

func (m tuiModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch v := msg.(type) {
	case tea.KeyMsg:
		switch v.String() {
		case "ctrl+c", "q":
			// User interrupt — let the worker observe context
			// cancel; we just quit the program here.
			return m, tea.Quit
		}
	case tuiStartMsg:
		m.total = v.total
		return m, nil
	case tuiStepMsg:
		m.currentKind = v.kind
		m.currentName = v.name
		return m, nil
	case tuiStepDoneMsg:
		m.completed++
		var line string
		if v.err != nil {
			line = m.failStyle.Render(fmt.Sprintf("  ✗ %s %s — %v", v.kind, v.name, v.err))
		} else {
			line = m.doneStyle.Render(fmt.Sprintf("  ✓ %s %s", v.kind, v.name))
		}
		m.history = append(m.history, line)
		if len(m.history) > m.maxHistory {
			m.history = m.history[len(m.history)-m.maxHistory:]
		}
		// Advance the progress bar.
		var cmd tea.Cmd
		if m.total > 0 {
			cmd = m.progress.SetPercent(float64(m.completed) / float64(m.total))
		}
		return m, cmd
	case tuiDoneMsg:
		m.finished = true
		return m, tea.Quit
	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd
	case progress.FrameMsg:
		newProg, cmd := m.progress.Update(msg)
		m.progress = newProg.(progress.Model)
		return m, cmd
	}
	return m, nil
}

func (m tuiModel) View() string {
	var b strings.Builder
	b.WriteString(m.headerStyle.Render("polaris-mail — provisioning Cloudflare resources"))
	b.WriteString("\n\n")
	for _, l := range m.history {
		b.WriteString(l)
		b.WriteString("\n")
	}
	if !m.finished && m.currentName != "" {
		b.WriteString(fmt.Sprintf("  %s %s %s\n",
			m.spinner.View(),
			m.dimStyle.Render(m.currentKind),
			m.currentName,
		))
	}
	if m.total > 0 {
		b.WriteString("\n")
		b.WriteString(m.progress.View())
		b.WriteString(fmt.Sprintf("  %d/%d\n", m.completed, m.total))
	}
	if m.finished {
		b.WriteString(m.dimStyle.Render(fmt.Sprintf("\ncompleted in %s\n", time.Since(time.Time{}).Truncate(0))))
	}
	return b.String()
}

// staticAssert: ensure tuiReporter implements provision.Reporter at
// compile time. Cheaper than a runtime smoke check.
var _ provision.Reporter = (*tuiReporter)(nil)
