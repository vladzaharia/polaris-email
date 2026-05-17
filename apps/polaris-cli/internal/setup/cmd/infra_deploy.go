package cmd

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/deploy"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/state"
)

// lastSHAFile is the default location for the "what SHA did we last
// deploy?" record. Mirrors bin/_lib.sh::LAST_SHA_FILE.
const lastSHAFile = ".deploy-state.last-sha"

// newInfraDeployCmd wires `polaris-email setup infra deploy`. Three
// children:
//
//   - deploy <service>   single named service
//   - deploy all         every service in canonical order
//   - deploy changed     only services whose code/deps changed since
//     the last deploy
func newInfraDeployCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "deploy",
		Short: "Deploy Workers (single service, all, or only changed)",
		Long: "Replace bin/deploy.sh with a Go-native deploy runner.\n" +
			"\n" +
			"Subcommands:\n" +
			"  deploy <service>   deploy one Worker (api|out|in|panel|docs|cli-installer)\n" +
			"  deploy all         deploy every Worker in canonical order\n" +
			"  deploy changed     deploy only services impacted by recent changes",
	}
	c.AddCommand(
		newInfraDeployOneCmd(),
		newInfraDeployAllCmd(),
		newInfraDeployChangedCmd(),
	)
	return c
}

// --- one-service deploy ----------------------------------------------

func newInfraDeployOneCmd() *cobra.Command {
	var (
		statePath string
		noBuild   bool
		force     bool
	)
	c := &cobra.Command{
		Use:   "service <name>",
		Short: "Deploy a single named Worker",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmdContext(cmd)
			svc, ok := deploy.ByName(args[0])
			if !ok {
				return fmt.Errorf("unknown service %q; expected one of: %s", args[0],
					strings.Join(deploy.Names(), ", "))
			}
			return runDeploy(ctx, cmd, []deploy.Service{svc}, statePath, noBuild, force)
		},
	}
	c.Flags().StringVar(&statePath, "state-path", "", "override .deploy-state.json path")
	c.Flags().BoolVar(&noBuild, "no-build", false, "skip the pnpm build:client step (panel + docs only)")
	c.Flags().BoolVar(&force, "force", false, "redeploy even when state already reflects the current SHA")
	return c
}

// --- all-services deploy ---------------------------------------------

func newInfraDeployAllCmd() *cobra.Command {
	var (
		statePath string
		noBuild   bool
		force     bool
	)
	c := &cobra.Command{
		Use:   "all",
		Short: "Deploy every Worker in canonical order",
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmdContext(cmd)
			if err := runDeploy(ctx, cmd, deploy.Services, statePath, noBuild, force); err != nil {
				return err
			}
			// Persist the head SHA so the next `deploy changed` run
			// has a starting point.
			root, _ := os.Getwd()
			sha, _ := readGitHEAD(ctx, root)
			if sha != "" {
				_ = deploy.WriteLastSHA(filepath.Join(root, lastSHAFile), sha)
			}
			return nil
		},
	}
	c.Flags().StringVar(&statePath, "state-path", "", "override .deploy-state.json path")
	c.Flags().BoolVar(&noBuild, "no-build", false, "skip the pnpm build:client step (panel + docs only)")
	c.Flags().BoolVar(&force, "force", false, "redeploy every service even when state already matches")
	return c
}

// --- changed-services deploy -----------------------------------------

func newInfraDeployChangedCmd() *cobra.Command {
	var (
		statePath string
		noBuild   bool
		force     bool
		baseSHA   string
	)
	c := &cobra.Command{
		Use:   "changed",
		Short: "Deploy only services whose code or transitive deps changed since the last deploy",
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmdContext(cmd)
			root, err := os.Getwd()
			if err != nil {
				return err
			}
			svcs, head, err := deploy.SelectChanged(ctx, deploy.ChangedOptions{
				RepoRoot:    root,
				BaseSHA:     baseSHA,
				LastSHAFile: filepath.Join(root, lastSHAFile),
			})
			if err != nil {
				return err
			}
			if len(svcs) == 0 {
				fmt.Fprintln(cmd.OutOrStdout(), "deploy: nothing changed since last deploy")
				// Still write the head SHA so re-runs don't re-diff
				// the same window.
				if head != "" {
					_ = deploy.WriteLastSHA(filepath.Join(root, lastSHAFile), head)
				}
				return nil
			}
			fmt.Fprintf(cmd.OutOrStdout(), "deploy: %d changed service(s): %s\n",
				len(svcs), joinNames(svcs))
			if err := runDeploy(ctx, cmd, svcs, statePath, noBuild, force); err != nil {
				return err
			}
			if head != "" {
				_ = deploy.WriteLastSHA(filepath.Join(root, lastSHAFile), head)
			}
			return nil
		},
	}
	c.Flags().StringVar(&statePath, "state-path", "", "override .deploy-state.json path")
	c.Flags().BoolVar(&noBuild, "no-build", false, "skip the pnpm build:client step (panel + docs only)")
	c.Flags().BoolVar(&force, "force", false, "redeploy services even when state already matches")
	c.Flags().StringVar(&baseSHA, "base-sha", "", "explicit base SHA for the diff (default: .deploy-state.last-sha → deployed/main → root commit)")
	return c
}

// runDeploy is the shared body of the three deploy leaves. Decides
// between TUI and plain reporter, wires the state store, and surfaces
// failures up to cobra.
func runDeploy(ctx context.Context, cmd *cobra.Command, svcs []deploy.Service, statePath string, noBuild, force bool) error {
	store := state.Open(pickPath(statePath, defaultStatePath))
	isTTY := isInteractiveStdin()
	var reporter deploy.Reporter
	var tuiR *deployTUIReporter
	if isTTY {
		tuiR = newDeployTUIReporter(cmd.OutOrStdout())
		reporter = tuiR
	} else {
		reporter = deploy.NewPlainReporter(cmd.OutOrStdout())
	}

	err := deploy.Deploy(ctx, svcs, store, deploy.Options{
		NoBuild:  noBuild,
		Force:    force,
		Reporter: reporter,
	})
	if tuiR != nil {
		tuiR.Done()
	}
	return err
}

// joinNames is a tiny helper for the "deploying: a, b, c" log line.
func joinNames(svcs []deploy.Service) string {
	out := make([]string, len(svcs))
	for i, s := range svcs {
		out[i] = s.Name
	}
	return strings.Join(out, ", ")
}

// cmdContext returns cmd.Context() or context.Background() — same
// pattern used by the other infra leaves.
func cmdContext(cmd *cobra.Command) context.Context {
	ctx := cmd.Context()
	if ctx == nil {
		ctx = context.Background()
	}
	return ctx
}

// readGitHEAD is a small wrapper that returns ("", nil) if git isn't
// usable. The deploy flow uses this only for the LastSHAFile write,
// which is best-effort.
func readGitHEAD(ctx context.Context, dir string) (string, error) {
	c := exec.CommandContext(ctx, "git", "rev-parse", "HEAD")
	c.Dir = dir
	out, err := c.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// --- TUI reporter ----------------------------------------------------

// deployTUIReporter shows one spinner + the currently-deploying service
// name, with done lines accumulated above. Pattern mirrors
// infra_apply_tui's reporter; differences are cosmetic (the deploy flow
// emits version IDs on success).
type deployTUIReporter struct {
	prog   *tea.Program
	wg     sync.WaitGroup
	closed sync.Once
}

func newDeployTUIReporter(out io.Writer) *deployTUIReporter {
	sp := spinner.New()
	sp.Spinner = spinner.Dot
	sp.Style = lipgloss.NewStyle().Foreground(lipgloss.Color("205"))
	m := deployTUIModel{
		spinner:     sp,
		maxHistory:  10,
		headerStyle: lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("39")),
		doneStyle:   lipgloss.NewStyle().Foreground(lipgloss.Color("42")),
		failStyle:   lipgloss.NewStyle().Foreground(lipgloss.Color("196")).Bold(true),
		dimStyle:    lipgloss.NewStyle().Foreground(lipgloss.Color("241")),
	}
	prog := tea.NewProgram(m, tea.WithOutput(out))
	r := &deployTUIReporter{prog: prog}
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		_, _ = prog.Run()
	}()
	return r
}

func (r *deployTUIReporter) Start(total int) { r.prog.Send(deployStartMsg{total: total}) }
func (r *deployTUIReporter) Step(service, phase string) {
	r.prog.Send(deployStepMsg{service: service, phase: phase})
}
func (r *deployTUIReporter) StepDone(service, vid string, err error) {
	r.prog.Send(deployDoneMsg{service: service, versionID: vid, err: err})
}
func (r *deployTUIReporter) Done() {
	r.closed.Do(func() {
		r.prog.Send(deployFinishMsg{})
		r.prog.Quit()
		r.wg.Wait()
	})
}

type deployStartMsg struct{ total int }
type deployStepMsg struct{ service, phase string }
type deployDoneMsg struct {
	service   string
	versionID string
	err       error
}
type deployFinishMsg struct{}

type deployTUIModel struct {
	spinner     spinner.Model
	total       int
	completed   int
	current     string
	phase       string
	history     []string
	maxHistory  int
	finished    bool
	headerStyle lipgloss.Style
	doneStyle   lipgloss.Style
	failStyle   lipgloss.Style
	dimStyle    lipgloss.Style
}

func (m deployTUIModel) Init() tea.Cmd { return m.spinner.Tick }

func (m deployTUIModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch v := msg.(type) {
	case tea.KeyMsg:
		if k := v.String(); k == "ctrl+c" || k == "q" {
			return m, tea.Quit
		}
	case deployStartMsg:
		m.total = v.total
		return m, nil
	case deployStepMsg:
		m.current = v.service
		m.phase = v.phase
		return m, nil
	case deployDoneMsg:
		m.completed++
		var line string
		switch {
		case v.err != nil:
			line = m.failStyle.Render(fmt.Sprintf("  ✗ %s — %v", v.service, v.err))
		case v.versionID != "":
			line = m.doneStyle.Render(fmt.Sprintf("  ✓ %s (version=%s)", v.service, v.versionID))
		default:
			line = m.doneStyle.Render(fmt.Sprintf("  ✓ %s", v.service))
		}
		m.history = append(m.history, line)
		if len(m.history) > m.maxHistory {
			m.history = m.history[len(m.history)-m.maxHistory:]
		}
		return m, nil
	case deployFinishMsg:
		m.finished = true
		return m, tea.Quit
	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd
	}
	return m, nil
}

func (m deployTUIModel) View() string {
	var b strings.Builder
	b.WriteString(m.headerStyle.Render("polaris-email — deploying Workers"))
	b.WriteString("\n\n")
	for _, l := range m.history {
		b.WriteString(l)
		b.WriteString("\n")
	}
	if !m.finished && m.current != "" {
		b.WriteString(fmt.Sprintf("  %s %s %s\n",
			m.spinner.View(),
			m.dimStyle.Render(m.phase),
			m.current,
		))
	}
	if m.total > 0 {
		b.WriteString(m.dimStyle.Render(fmt.Sprintf("\n  %d/%d\n", m.completed, m.total)))
	}
	return b.String()
}
