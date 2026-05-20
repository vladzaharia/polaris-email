package cmd

import (
	"fmt"
	"io"
	"strings"
	"sync"

	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/rollback"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/secrets"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/state"
)

// newInfraRollbackCmd wires `setup infra rollback {deploy|secret|phase}`.
//
// Tiered intent:
//
//   - deploy: cheap, `wrangler rollback`. Safe to chain.
//   - secret: medium, 1-deep archive replay. Refuses if no archive.
//   - phase:  advisory; resets the marker, never deletes CF state.
func newInfraRollbackCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "rollback",
		Short: "Roll back a Worker deploy, a rotated secret, or a phase marker",
		Long: "Three-tier rollback for the setup flow:\n" +
			"\n" +
			"  rollback deploy <service>   shell out to `wrangler rollback`.\n" +
			"  rollback secret <name>      re-push the archived previous value\n" +
			"                              of a rotated secret (1-deep history).\n" +
			"  rollback phase  <name>      reset a phase marker so `--resume`\n" +
			"                              re-runs it. Prints manual remediation\n" +
			"                              for any side-effects. NEVER deletes\n" +
			"                              CF resources — that destroys data.\n",
	}
	c.AddCommand(
		newInfraRollbackDeployCmd(),
		newInfraRollbackSecretCmd(),
		newInfraRollbackPhaseCmd(),
	)
	return c
}

// --- deploy ----------------------------------------------------------

func newInfraRollbackDeployCmd() *cobra.Command {
	var (
		statePath string
		toVersion string
	)
	c := &cobra.Command{
		Use:   "deploy <service>",
		Short: "Roll a Worker back to a previous wrangler version",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmdContext(cmd)
			store := state.Open(pickPath(statePath, defaultStatePath))
			err := rollback.RollbackDeploy(ctx, args[0], store, rollback.DeployOptions{
				ToVersion: toVersion,
				Reporter: func(svc, vid string, err error) {
					if err != nil {
						fmt.Fprintf(cmd.OutOrStdout(), "rollback %s: FAILED rolling to %s: %v\n", svc, vid, err)
						return
					}
					fmt.Fprintf(cmd.OutOrStdout(), "rollback %s: rolled to %s\n", svc, vid)
				},
			})
			return err
		},
	}
	c.Flags().StringVar(&statePath, "state-path", "", "override .deploy-state.json path")
	c.Flags().StringVar(&toVersion, "to-version", "", "explicit wrangler version id to roll back to (default: state's PreviousVersionID)")
	return c
}

// --- secret ----------------------------------------------------------

func newInfraRollbackSecretCmd() *cobra.Command {
	var (
		archivePath    string
		recordPath     string
		nonInteractive bool
	)
	c := &cobra.Command{
		Use:   "secret <name>",
		Short: "Re-push the archived previous value of a rotated secret",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmdContext(cmd)
			arch := rollback.NewArchive(pickPath(archivePath, rollback.DefaultArchivePath))
			rec := secrets.NewRecorder(pickPath(recordPath, secrets.DefaultRecordPath))

			isTTY := !nonInteractive && isInteractiveStdin()
			var rep secrets.Reporter
			var tuiR *rollbackTUIReporter
			if isTTY {
				tuiR = newRollbackTUIReporter(cmd.OutOrStdout(), "polaris-email — rolling back secret")
				rep = tuiR
			} else {
				rep = newSecretsPlainReporter(cmd.OutOrStdout())
			}

			err := rollback.RollbackSecret(ctx, args[0], rollback.SecretOptions{
				Archive:  arch,
				Pusher:   secrets.WranglerPusher{},
				Recorder: rec,
				Reporter: rep,
			})
			if tuiR != nil {
				tuiR.Done()
			}
			return err
		},
	}
	c.Flags().StringVar(&archivePath, "archive-path", "", "override .secrets.archive.json path")
	c.Flags().StringVar(&recordPath, "record-path", "", "override secrets.created.json path")
	c.Flags().BoolVar(&nonInteractive, "non-interactive", false, "force plain-stdout output (no TUI)")
	return c
}

// --- phase -----------------------------------------------------------

func newInfraRollbackPhaseCmd() *cobra.Command {
	var statePath string
	c := &cobra.Command{
		Use:   "phase <name>",
		Short: "Reset a phase marker and print manual remediation steps",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmdContext(cmd)
			store := state.Open(pickPath(statePath, defaultStatePath))
			return rollback.RollbackPhase(ctx, store, args[0], rollback.PhaseOptions{
				Out: cmd.OutOrStdout(),
			})
		},
	}
	c.Flags().StringVar(&statePath, "state-path", "", "override .deploy-state.json path")
	return c
}

// --- TUI reporter (used by `rollback secret` and `secrets rotate`) ---

// rollbackTUIReporter is a one-spinner-per-step Reporter. Pattern
// mirrors deployTUIReporter; the only difference is the header text.
type rollbackTUIReporter struct {
	prog   *tea.Program
	wg     sync.WaitGroup
	closed sync.Once
}

func newRollbackTUIReporter(out io.Writer, header string) *rollbackTUIReporter {
	sp := spinner.New()
	sp.Spinner = spinner.Dot
	sp.Style = lipgloss.NewStyle().Foreground(lipgloss.Color("205"))
	m := rollbackTUIModel{
		spinner:     sp,
		header:      header,
		maxHistory:  10,
		headerStyle: lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("39")),
		doneStyle:   lipgloss.NewStyle().Foreground(lipgloss.Color("42")),
		failStyle:   lipgloss.NewStyle().Foreground(lipgloss.Color("196")).Bold(true),
		dimStyle:    lipgloss.NewStyle().Foreground(lipgloss.Color("241")),
	}
	prog := tea.NewProgram(m, tea.WithOutput(out))
	r := &rollbackTUIReporter{prog: prog}
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		_, _ = prog.Run()
	}()
	return r
}

func (r *rollbackTUIReporter) Start(total int) { r.prog.Send(rollbackStartMsg{total: total}) }
func (r *rollbackTUIReporter) Step(name, service string) {
	r.prog.Send(rollbackStepMsg{label: service + "/" + name})
}
func (r *rollbackTUIReporter) StepDone(name, service string, err error) {
	r.prog.Send(rollbackStepDoneMsg{label: service + "/" + name, err: err})
}
func (r *rollbackTUIReporter) Done() {
	r.closed.Do(func() {
		r.prog.Send(rollbackFinishMsg{})
		r.prog.Quit()
		r.wg.Wait()
	})
}

type rollbackStartMsg struct{ total int }
type rollbackStepMsg struct{ label string }
type rollbackStepDoneMsg struct {
	label string
	err   error
}
type rollbackFinishMsg struct{}

type rollbackTUIModel struct {
	spinner     spinner.Model
	header      string
	total       int
	completed   int
	current     string
	history     []string
	maxHistory  int
	finished    bool
	headerStyle lipgloss.Style
	doneStyle   lipgloss.Style
	failStyle   lipgloss.Style
	dimStyle    lipgloss.Style
}

func (m rollbackTUIModel) Init() tea.Cmd { return m.spinner.Tick }

func (m rollbackTUIModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch v := msg.(type) {
	case tea.KeyMsg:
		if k := v.String(); k == "ctrl+c" || k == "q" {
			return m, tea.Quit
		}
	case rollbackStartMsg:
		m.total = v.total
		return m, nil
	case rollbackStepMsg:
		m.current = v.label
		return m, nil
	case rollbackStepDoneMsg:
		m.completed++
		var line string
		if v.err != nil {
			line = m.failStyle.Render(fmt.Sprintf("  ✗ %s — %v", v.label, v.err))
		} else {
			line = m.doneStyle.Render(fmt.Sprintf("  ✓ %s", v.label))
		}
		m.history = append(m.history, line)
		if len(m.history) > m.maxHistory {
			m.history = m.history[len(m.history)-m.maxHistory:]
		}
		return m, nil
	case rollbackFinishMsg:
		m.finished = true
		return m, tea.Quit
	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd
	}
	return m, nil
}

func (m rollbackTUIModel) View() string {
	var b strings.Builder
	b.WriteString(m.headerStyle.Render(m.header))
	b.WriteString("\n\n")
	for _, l := range m.history {
		b.WriteString(l)
		b.WriteString("\n")
	}
	if !m.finished && m.current != "" {
		b.WriteString(fmt.Sprintf("  %s %s\n", m.spinner.View(), m.current))
	}
	if m.total > 0 {
		b.WriteString(m.dimStyle.Render(fmt.Sprintf("\n  %d/%d\n", m.completed, m.total)))
	}
	return b.String()
}

// staticAssert: tuiReporter conforms to secrets.Reporter.
var _ secrets.Reporter = (*rollbackTUIReporter)(nil)
