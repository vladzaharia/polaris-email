package cmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/config"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/genesis"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/state"
)

// genesisSealPhaseName is the phase key recorded in .deploy-state.json
// once the seal completes. The happy-path runner short-circuits past
// this phase on --resume when CompletedAt is non-zero.
const genesisSealPhaseName = "genesis-seal"

// newInfraGenesisSealCmd wires `polaris-email setup infra genesis-seal`.
// Required input: POLARIS_SECRET_A — either via the in-memory secrets
// context (from the runner) or via --secret on the CLI (operator-side
// override when re-running the seal manually).
func newInfraGenesisSealCmd() *cobra.Command {
	var (
		envFile        string
		statePath      string
		outputPath     string
		secret         string
		webauthnToken  string
		idempotencyKey string
		noBrowser      bool
		force          bool
		nonInteractive bool
		apiBaseURL     string
		pollIntervalMS int
		pollTimeoutS   int
	)
	c := &cobra.Command{
		Use:   "genesis-seal",
		Short: "Sign + send the one-time bootstrap POST and complete WebAuthn enrolment",
		Long: "Run the genesis-seal phase of the cold-start flow.\n" +
			"\n" +
			"This is the final piece of `setup infra` (no leaf): once the\n" +
			"Worker fleet is deployed and POLARIS_SECRET_A is live in every\n" +
			"service's wrangler secrets, the CLI signs the canonical\n" +
			"`POST /v1/admin/bootstrap` request with the freshly seeded\n" +
			"secret, captures the minted admin key, opens the operator's\n" +
			"browser to the WebAuthn enrolment URL, and polls the server\n" +
			"until the ceremony completes (or the 5-minute code expires).\n" +
			"\n" +
			"On success the admin key is written to .bootstrap-output.json\n" +
			"(mode 0600) and the seal phase is recorded in .deploy-state.json.",
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			if ctx == nil {
				ctx = context.Background()
			}
			cfg, _ := config.LoadOrDefault(envFile)

			baseURL := apiBaseURL
			if baseURL == "" {
				baseURL = resolveAPIBaseURL(cfg)
			}
			if baseURL == "" {
				return errors.New("no API base URL: pass --api-base-url, set POLARIS_API_HOSTNAME in .env.deploy, or POLARIS_API_BASE_URL")
			}

			masterSecret := secret
			if masterSecret == "" {
				masterSecret = os.Getenv("POLARIS_SECRET_A")
			}
			if masterSecret == "" {
				return errors.New("POLARIS_SECRET_A is required (pass --secret, set POLARIS_SECRET_A env, or run as part of `setup infra` so the seed phase keeps it in memory)")
			}

			// Resume short-circuit (unless --force).
			store := state.Open(pickPath(statePath, defaultStatePath))
			doc, _ := store.Read()
			if !force && doc != nil && doc.Phases != nil {
				if ph, ok := doc.Phases[genesisSealPhaseName]; ok && !ph.CompletedAt.IsZero() {
					fmt.Fprintln(cmd.OutOrStdout(),
						"genesis-seal: already completed (re-run with --force to redo)")
					return nil
				}
			}

			opts := genesis.SealOptions{
				APIBaseURL:     baseURL,
				MasterSecret:   masterSecret,
				WebAuthnToken:  webauthnToken,
				IdempotencyKey: idempotencyKey,
				NoBrowser:      noBrowser || nonInteractive,
				OutputPath:     pickPath(outputPath, genesis.DefaultBootstrapOutputPath),
				PollInterval:   time.Duration(pollIntervalMS) * time.Millisecond,
				PollTimeout:    time.Duration(pollTimeoutS) * time.Second,
			}

			isTTY := !nonInteractive && isInteractiveStdin()
			var tuiR *sealTUIReporter
			if isTTY {
				tuiR = newSealTUIReporter(cmd.OutOrStdout())
				opts.Out = io.Discard // TUI owns the output; suppress library prints
			} else {
				opts.Out = cmd.OutOrStdout()
			}

			result, sealErr := genesis.Seal(ctx, opts)
			if tuiR != nil {
				tuiR.Done()
			}
			if sealErr != nil {
				if genesis.IsAlreadyBootstrapped(sealErr) && !force {
					fmt.Fprintln(cmd.OutOrStdout(),
						"genesis-seal: already bootstrapped (server reports an admin key exists). " +
							"Re-run with --force to force a re-seal once you've torn down the prior key.")
					// Treat as success — the cold-start runner is
					// idempotent and the operator already has an admin
					// key from a prior run.
					return recordPhaseComplete(store, genesisSealPhaseName)
				}
				return sealErr
			}
			if result != nil {
				fmt.Fprintf(cmd.OutOrStdout(),
					"genesis-seal: admin_key_id=%s mailbox_id=%s webauthn_enrolled=%t\n",
					result.AdminKeyID, result.MailboxID, result.WebAuthnEnrolled,
				)
			}
			return recordPhaseComplete(store, genesisSealPhaseName)
		},
	}
	c.Flags().StringVar(&envFile, "env-file", defaultEnvFile, "path to .env.deploy")
	c.Flags().StringVar(&statePath, "state-path", "", "override .deploy-state.json path")
	c.Flags().StringVar(&outputPath, "output", "", "where to write the admin key blob (default .bootstrap-output.json)")
	c.Flags().StringVar(&secret, "secret", "", "POLARIS_SECRET_A plaintext (defaults to in-memory map / env)")
	c.Flags().StringVar(&webauthnToken, "webauthn-token", "", "headless WebAuthn-stamped JWT (skips browser ceremony)")
	c.Flags().StringVar(&idempotencyKey, "idempotency-key", "", "Idempotency-Key header so retries replay the prior response")
	c.Flags().BoolVar(&noBrowser, "no-browser", false, "do not open a browser; print the enrolment URL only")
	c.Flags().BoolVar(&force, "force", false, "re-run the seal even when state says it already completed")
	c.Flags().BoolVar(&nonInteractive, "non-interactive", false, "force plain-stdout output (no TUI), implies --no-browser")
	c.Flags().StringVar(&apiBaseURL, "api-base-url", "", "override the API base URL (default: https://<POLARIS_API_HOSTNAME>)")
	c.Flags().IntVar(&pollIntervalMS, "poll-interval-ms", 2000, "WebAuthn poll interval (ms)")
	c.Flags().IntVar(&pollTimeoutS, "poll-timeout-s", 300, "max time to wait for WebAuthn completion (s)")
	return c
}

// resolveAPIBaseURL mirrors the smoke flow's resolution: prefer
// POLARIS_API_BASE_URL env, then https://POLARIS_API_HOSTNAME from
// .env.deploy.
func resolveAPIBaseURL(cfg *config.Config) string {
	if envURL := os.Getenv("POLARIS_API_BASE_URL"); envURL != "" {
		return envURL
	}
	if cfg != nil && cfg.PolarisAPIHostname != "" {
		return "https://" + cfg.PolarisAPIHostname
	}
	return ""
}

// recordPhaseComplete stamps the seal phase as done in
// .deploy-state.json so --resume can skip it on the next run.
func recordPhaseComplete(store *state.Store, name string) error {
	if store == nil {
		return nil
	}
	doc, err := store.Read()
	if err != nil {
		return fmt.Errorf("record phase: read state: %w", err)
	}
	if doc.Phases == nil {
		doc.Phases = map[string]state.Phase{}
	}
	doc.Phases[name] = state.Phase{CompletedAt: time.Now().UTC()}
	return store.Write(doc)
}

// --- TUI reporter -----------------------------------------------------

// sealTUIReporter is a small bubble-tea spinner that runs alongside
// the seal flow's poll loop. The seal package writes its own status
// lines to opts.Out; the TUI deliberately keeps the screen real-estate
// quiet (one spinner + a short label) so the operator's terminal
// doesn't churn while they're in the browser.
type sealTUIReporter struct {
	prog   *tea.Program
	wg     sync.WaitGroup
	closed sync.Once
}

func newSealTUIReporter(out io.Writer) *sealTUIReporter {
	sp := spinner.New()
	sp.Spinner = spinner.Dot
	sp.Style = lipgloss.NewStyle().Foreground(lipgloss.Color("205"))
	m := sealTUIModel{
		spinner:     sp,
		headerStyle: lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("39")),
		dimStyle:    lipgloss.NewStyle().Foreground(lipgloss.Color("241")),
	}
	prog := tea.NewProgram(m, tea.WithOutput(out))
	r := &sealTUIReporter{prog: prog}
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		_, _ = prog.Run()
	}()
	return r
}

func (r *sealTUIReporter) Done() {
	r.closed.Do(func() {
		r.prog.Send(sealDoneMsg{})
		r.prog.Quit()
		r.wg.Wait()
	})
}

type sealDoneMsg struct{}

type sealTUIModel struct {
	spinner     spinner.Model
	finished    bool
	headerStyle lipgloss.Style
	dimStyle    lipgloss.Style
}

func (m sealTUIModel) Init() tea.Cmd { return m.spinner.Tick }

func (m sealTUIModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch v := msg.(type) {
	case tea.KeyMsg:
		if k := v.String(); k == "ctrl+c" || k == "q" {
			return m, tea.Quit
		}
	case sealDoneMsg:
		m.finished = true
		return m, tea.Quit
	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd
	}
	return m, nil
}

func (m sealTUIModel) View() string {
	var b strings.Builder
	b.WriteString(m.headerStyle.Render("polaris-email — genesis seal"))
	b.WriteString("\n\n")
	if !m.finished {
		b.WriteString(fmt.Sprintf("  %s %s\n",
			m.spinner.View(),
			m.dimStyle.Render("waiting for WebAuthn enrolment to complete..."),
		))
	}
	return b.String()
}
