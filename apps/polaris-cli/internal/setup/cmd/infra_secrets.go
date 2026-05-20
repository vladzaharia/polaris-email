package cmd

import (
	"context"
	"fmt"
	"io"
	"strings"
	"sync"

	"github.com/charmbracelet/bubbles/progress"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/output"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/config"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/deploy"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/rollback"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/secrets"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/secrets/sources"
)

// newInfraSecretsCmd wires `polaris-email setup infra secrets`. The
// `seed` leaf is the primary entry; `list`, `rotate`, and `from-vault`
// are knob-turning subcommands operators reach for during maintenance.
func newInfraSecretsCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "secrets",
		Short: "Generate + push master secrets to every Worker via wrangler",
		Long: "Seed and audit the master secrets polaris-email needs:\n" +
			"POLARIS_SECRET_A, ARGON2_PEPPER, and the optional OIDC\n" +
			"client secret.\n" +
			"\n" +
			"Master secret values are never written to disk by this command.\n" +
			"They flow through an in-memory map straight into wrangler's\n" +
			"stdin; the audit record (secrets.created.json) carries only the\n" +
			"sha256 of each value.",
	}
	c.AddCommand(
		newInfraSecretsSeedCmd(),
		newInfraSecretsListCmd(),
		newInfraSecretsRotateCmd(),
		newInfraSecretsFromVaultCmd(),
	)
	return c
}

// --- seed ------------------------------------------------------------

func newInfraSecretsSeedCmd() *cobra.Command {
	var (
		envFile        string
		recordPath     string
		nonInteractive bool
		useVault       bool
		useKeychain    bool
		skipPanel      bool
	)
	c := &cobra.Command{
		Use:   "seed",
		Short: "Generate + push every master secret across all Workers (idempotent)",
		Long: "Seed the master secrets across every Worker. Idempotent —\n" +
			"already-recorded (service, name) tuples are skipped on re-run.\n" +
			"\n" +
			"Source chain (first non-empty wins):\n" +
			"  1. Process env / .env.deploy overlay.\n" +
			"  2. 1Password vault via `op read` (when --vault).\n" +
			"  3. OS keychain (when --keychain, build with -tags keyring).\n" +
			"\n" +
			"Falls back to crypto/rand generation for POLARIS_SECRET_A and\n" +
			"ARGON2_PEPPER. OIDC client secret is optional — skipped cleanly\n" +
			"when no source provides one.",
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			if ctx == nil {
				ctx = context.Background()
			}
			cfg, _ := config.LoadOrDefault(envFile)

			// Build the env-source overlay from .env.deploy. We feed
			// .env.deploy values in via Overrides so the runner can
			// resolve OIDC_CLIENT_SECRET without requiring os.Setenv
			// juggling.
			overrides := map[string]string{}
			if cfg != nil {
				for k, v := range cfg.AsMap() {
					if v != "" {
						overrides[k] = v
					}
				}
			}
			srcs := []sources.Source{
				sources.NewEnvSource(overrides),
			}
			if useVault {
				srcs = append(srcs, &sources.VaultSource{})
			}
			if useKeychain {
				srcs = append(srcs, &sources.KeyringSource{})
			}

			// Build the workers list. POLARIS_SECRET_A goes to every
			// Worker; the rest of the specs target a subset already.
			workers := deploy.Names()
			if skipPanel {
				workers = filterOut(workers, "panel")
			}

			specs := secrets.DefaultSpecs(workers)
			rec := secrets.NewRecorder(pickPath(recordPath, secrets.DefaultRecordPath))

			isTTY := !nonInteractive && isInteractiveStdin()
			var reporter secrets.Reporter
			var tuiR *secretsTUIReporter
			if isTTY {
				tuiR = newSecretsTUIReporter(cmd.OutOrStdout())
				reporter = tuiR
			} else {
				reporter = newSecretsPlainReporter(cmd.OutOrStdout())
			}

			pusher := secrets.WranglerPusher{}

			generated, err := secrets.Seed(ctx, specs, srcs, pusher, rec, reporter)
			if tuiR != nil {
				tuiR.Done()
			}
			if err != nil {
				return err
			}
			// `generated` is intentionally not logged — it carries
			// plaintext values for the genesis-seal phase to consume.
			_ = generated
			fmt.Fprintf(cmd.OutOrStdout(), "secrets: seed complete (%d audit row(s) at %s)\n",
				countRecords(rec), rec.Path)
			return nil
		},
	}
	c.Flags().StringVar(&envFile, "env-file", defaultEnvFile, "path to .env.deploy")
	c.Flags().StringVar(&recordPath, "record-path", "", "override secrets.created.json path")
	c.Flags().BoolVar(&nonInteractive, "non-interactive", false, "force plain-stdout output (no TUI)")
	c.Flags().BoolVar(&useVault, "vault", false, "include the 1Password vault source")
	c.Flags().BoolVar(&useKeychain, "keychain", false, "include the OS keychain source (build with -tags keyring)")
	c.Flags().BoolVar(&skipPanel, "skip-panel", false, "skip pushing POLARIS_SECRET_A to the panel Worker")
	return c
}

// --- list ------------------------------------------------------------

func newInfraSecretsListCmd() *cobra.Command {
	var (
		recordPath string
		format     string
	)
	c := &cobra.Command{
		Use:   "list",
		Short: "List sha256-only audit rows from secrets.created.json",
		RunE: func(cmd *cobra.Command, _ []string) error {
			rec := secrets.NewRecorder(pickPath(recordPath, secrets.DefaultRecordPath))
			entries, err := rec.All()
			if err != nil {
				return err
			}
			f, err := output.ParseFormat(format)
			if err != nil {
				return err
			}
			w := cmd.OutOrStdout()
			switch f {
			case output.FormatJSON:
				return output.EmitJSON(w, entries)
			case output.FormatYAML:
				return output.EmitYAML(w, entries)
			}
			if len(entries) == 0 {
				fmt.Fprintln(w, "no secrets recorded — run `setup infra secrets seed` first")
				return nil
			}
			t := &output.Table{Headers: []string{"SERVICE", "NAME", "SHA256 (first 8)", "CREATED"}}
			for _, e := range entries {
				sha := e.SHA256
				if len(sha) > 8 {
					sha = sha[:8] + "..."
				}
				t.Rows = append(t.Rows, []string{
					e.Service, e.Name, sha, e.CreatedAt.Format("2006-01-02 15:04:05Z"),
				})
			}
			return t.Render(w)
		},
	}
	c.Flags().StringVar(&recordPath, "record-path", "", "override secrets.created.json path")
	c.Flags().StringVarP(&format, "output", "o", "table", "output format: table|json|yaml")
	return c
}

// --- rotate ----------------------------------------------------------

func newInfraSecretsRotateCmd() *cobra.Command {
	var (
		envFile        string
		recordPath     string
		archivePath    string
		nonInteractive bool
		useVault       bool
		useKeychain    bool
		noArchive      bool
	)
	c := &cobra.Command{
		Use:   "rotate <name>",
		Short: "Rotate a single secret: generate-new → archive-old → re-push to every recorded service",
		Long: "Rotate a single master secret end-to-end.\n" +
			"\n" +
			"  1. Read the current value via the same source chain as `seed`.\n" +
			"  2. Mint a new value with the same byte-shape (base64 vs hex).\n" +
			"  3. Archive the OLD value to .secrets.archive.json (1-deep).\n" +
			"  4. Push the NEW value to every service the recorder lists.\n" +
			"  5. Re-stamp secrets.created.json with the new sha256.\n" +
			"\n" +
			"To roll back: `setup infra rollback secret <name>` re-pushes the\n" +
			"archived previous value.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmdContext(cmd)
			cfg, _ := config.LoadOrDefault(envFile)
			overrides := map[string]string{}
			if cfg != nil {
				for k, v := range cfg.AsMap() {
					if v != "" {
						overrides[k] = v
					}
				}
			}
			srcs := []sources.Source{sources.NewEnvSource(overrides)}
			if useVault {
				srcs = append(srcs, &sources.VaultSource{})
			}
			if useKeychain {
				srcs = append(srcs, &sources.KeyringSource{})
			}

			rec := secrets.NewRecorder(pickPath(recordPath, secrets.DefaultRecordPath))
			var arch secrets.RotateArchiver
			archP := pickPath(archivePath, rollback.DefaultArchivePath)
			if !noArchive {
				arch = rollback.NewArchive(archP)
			}

			isTTY := !nonInteractive && isInteractiveStdin()
			var reporter secrets.Reporter
			var tuiR *rollbackTUIReporter
			if isTTY {
				tuiR = newRollbackTUIReporter(cmd.OutOrStdout(), "polaris-email — rotating secret")
				reporter = tuiR
			} else {
				reporter = newSecretsPlainReporter(cmd.OutOrStdout())
			}

			err := secrets.Rotate(ctx, args[0], secrets.RotateOptions{
				Sources:  srcs,
				Pusher:   secrets.WranglerPusher{},
				Recorder: rec,
				Archive:  arch,
				Reporter: reporter,
			})
			if tuiR != nil {
				tuiR.Done()
			}
			if err != nil {
				return err
			}
			if noArchive {
				fmt.Fprintf(cmd.OutOrStdout(), "secrets: rotated %s (no archive — rollback impossible)\n", args[0])
			} else {
				fmt.Fprintf(cmd.OutOrStdout(), "secrets: rotated %s — old value archived to %s\n", args[0], archP)
			}
			return nil
		},
	}
	c.Flags().StringVar(&envFile, "env-file", defaultEnvFile, "path to .env.deploy")
	c.Flags().StringVar(&recordPath, "record-path", "", "override secrets.created.json path")
	c.Flags().StringVar(&archivePath, "archive-path", "", "override .secrets.archive.json path")
	c.Flags().BoolVar(&nonInteractive, "non-interactive", false, "force plain-stdout output (no TUI)")
	c.Flags().BoolVar(&useVault, "vault", false, "include the 1Password vault source")
	c.Flags().BoolVar(&useKeychain, "keychain", false, "include the OS keychain source (build with -tags keyring)")
	c.Flags().BoolVar(&noArchive, "no-archive", false, "skip writing the archive (rollback will be impossible)")
	return c
}

// --- from-vault ------------------------------------------------------

func newInfraSecretsFromVaultCmd() *cobra.Command {
	var (
		recordPath string
		envFile    string
	)
	c := &cobra.Command{
		Use:   "from-vault",
		Short: "Seed secrets pulling exclusively from the 1Password vault (no generation)",
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			if ctx == nil {
				ctx = context.Background()
			}
			cfg, _ := config.LoadOrDefault(envFile)
			overrides := map[string]string{}
			if cfg != nil {
				for k, v := range cfg.AsMap() {
					if v != "" {
						overrides[k] = v
					}
				}
			}
			srcs := []sources.Source{
				&sources.VaultSource{},
				sources.NewEnvSource(overrides),
			}
			// Strip generators so the runner refuses to mint a value
			// the vault didn't supply.
			specs := secrets.DefaultSpecs(deploy.Names())
			for i := range specs {
				specs[i].Generator = nil
			}
			rec := secrets.NewRecorder(pickPath(recordPath, secrets.DefaultRecordPath))
			rep := newSecretsPlainReporter(cmd.OutOrStdout())
			_, err := secrets.Seed(ctx, specs, srcs, secrets.WranglerPusher{}, rec, rep)
			return err
		},
	}
	c.Flags().StringVar(&recordPath, "record-path", "", "override secrets.created.json path")
	c.Flags().StringVar(&envFile, "env-file", defaultEnvFile, "path to .env.deploy")
	return c
}

// --- helpers ---------------------------------------------------------

func filterOut(slice []string, drop string) []string {
	out := make([]string, 0, len(slice))
	for _, s := range slice {
		if s != drop {
			out = append(out, s)
		}
	}
	return out
}

func countRecords(rec *secrets.Recorder) int {
	all, err := rec.All()
	if err != nil {
		return 0
	}
	return len(all)
}

// --- reporters -------------------------------------------------------

// secretsPlainReporter emits one line per (service, secret) push.
type secretsPlainReporter struct {
	w     io.Writer
	total int
	done  int
}

func newSecretsPlainReporter(w io.Writer) *secretsPlainReporter {
	return &secretsPlainReporter{w: w}
}

func (r *secretsPlainReporter) Start(total int) {
	r.total = total
	if r.w != nil && total > 0 {
		fmt.Fprintf(r.w, "secrets: seeding %d (service, name) pair(s)\n", total)
	}
}

func (r *secretsPlainReporter) Step(name, service string) {
	r.done++
	if r.w == nil {
		return
	}
	fmt.Fprintf(r.w, "  [%d/%d] %s/%s ... ", r.done, r.total, service, name)
}

func (r *secretsPlainReporter) StepDone(_, _ string, err error) {
	if r.w == nil {
		return
	}
	if err != nil {
		fmt.Fprintf(r.w, "FAILED: %v\n", err)
		return
	}
	fmt.Fprintln(r.w, "ok")
}

func (r *secretsPlainReporter) Done() {
	if r.w == nil || r.total == 0 {
		return
	}
	fmt.Fprintln(r.w, "secrets: done")
}

// secretsTUIReporter renders a progress bar + live current-step line.
// The model is intentionally simpler than infra_apply_tui — we don't
// need history of done items because the audit record on disk already
// captures everything; instead we just show the progress bar and the
// most recent push.
type secretsTUIReporter struct {
	prog   *tea.Program
	wg     sync.WaitGroup
	closed sync.Once
}

func newSecretsTUIReporter(out io.Writer) *secretsTUIReporter {
	m := secretsTUIModel{
		progress:    progress.New(progress.WithDefaultGradient()),
		headerStyle: lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("39")),
		dimStyle:    lipgloss.NewStyle().Foreground(lipgloss.Color("241")),
		failStyle:   lipgloss.NewStyle().Foreground(lipgloss.Color("196")).Bold(true),
	}
	m.progress.Width = 40
	prog := tea.NewProgram(m, tea.WithOutput(out))
	r := &secretsTUIReporter{prog: prog}
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		_, _ = prog.Run()
	}()
	return r
}

func (r *secretsTUIReporter) Start(total int) { r.prog.Send(secretsTotalMsg{total: total}) }

func (r *secretsTUIReporter) Step(name, service string) {
	r.prog.Send(secretsStepMsg{label: service + "/" + name})
}

func (r *secretsTUIReporter) StepDone(name, service string, err error) {
	r.prog.Send(secretsStepDoneMsg{label: service + "/" + name, err: err})
}

func (r *secretsTUIReporter) Done() {
	r.closed.Do(func() {
		r.prog.Send(secretsDoneMsg{})
		r.prog.Quit()
		r.wg.Wait()
	})
}

type secretsTotalMsg struct{ total int }
type secretsStepMsg struct{ label string }
type secretsStepDoneMsg struct {
	label string
	err   error
}
type secretsDoneMsg struct{}

type secretsTUIModel struct {
	progress    progress.Model
	total       int
	completed   int
	current     string
	lastError   string
	finished    bool
	headerStyle lipgloss.Style
	dimStyle    lipgloss.Style
	failStyle   lipgloss.Style
}

func (m secretsTUIModel) Init() tea.Cmd { return nil }

func (m secretsTUIModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch v := msg.(type) {
	case tea.KeyMsg:
		if k := v.String(); k == "ctrl+c" || k == "q" {
			return m, tea.Quit
		}
	case secretsTotalMsg:
		m.total = v.total
		return m, nil
	case secretsStepMsg:
		m.current = v.label
		return m, nil
	case secretsStepDoneMsg:
		m.completed++
		if v.err != nil {
			m.lastError = m.failStyle.Render(fmt.Sprintf("  ✗ %s — %v", v.label, v.err))
		}
		var cmd tea.Cmd
		if m.total > 0 {
			cmd = m.progress.SetPercent(float64(m.completed) / float64(m.total))
		}
		return m, cmd
	case secretsDoneMsg:
		m.finished = true
		return m, tea.Quit
	case progress.FrameMsg:
		newProg, cmd := m.progress.Update(msg)
		m.progress = newProg.(progress.Model)
		return m, cmd
	}
	return m, nil
}

func (m secretsTUIModel) View() string {
	var b strings.Builder
	b.WriteString(m.headerStyle.Render("polaris-email — seeding secrets"))
	b.WriteString("\n\n")
	if m.current != "" && !m.finished {
		b.WriteString("  ")
		b.WriteString(m.dimStyle.Render("pushing "))
		b.WriteString(m.current)
		b.WriteString("\n")
	}
	if m.lastError != "" {
		b.WriteString(m.lastError)
		b.WriteString("\n")
	}
	if m.total > 0 {
		b.WriteString("\n")
		b.WriteString(m.progress.View())
		b.WriteString(fmt.Sprintf("  %d/%d\n", m.completed, m.total))
	}
	return b.String()
}

