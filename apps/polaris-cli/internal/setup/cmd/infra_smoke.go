package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/charmbracelet/bubbles/table"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/output"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/config"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/smoke"
)

// defaultBootstrapOutput is the JSON blob containing the admin key id
// + secret written by the genesis-seal phase.
const defaultBootstrapOutput = ".bootstrap-output.json"

// bootstrapOutput is the JSON shape written to .bootstrap-output.json
// by the genesis-seal phase. MailboxID is carried so
// `setup infra rotate-admin-key` can mint the replacement key against
// the same operator mailbox.
type bootstrapOutput struct {
	AdminKeyID     string `json:"admin_key_id"`
	AdminKeySecret string `json:"admin_key_secret"`
	MailboxID      string `json:"mailbox_id,omitempty"`
	CreatedAt      string `json:"created_at,omitempty"`
}

// newInfraSmokeCmd wires `polaris-email setup infra smoke`.
func newInfraSmokeCmd() *cobra.Command {
	var (
		envFile         string
		bootstrapOutput string
		skipSynthetic   bool
		outputFmt       string
		pollIntervalMS  int
		pollTimeoutS    int
	)
	c := &cobra.Command{
		Use:   "smoke",
		Short: "End-to-end smoke test: healthz + signed status + synthetic outbound",
		Long: "Run three end-to-end checks:\n" +
			"\n" +
			"  1. GET /healthz → 200\n" +
			"  2. Signed GET /v1/admin/status → mailboxes + domains present\n" +
			"  3. POST /v1/messages + 60s poll for status=delivered\n" +
			"\n" +
			"--skip-synthetic suppresses the third check (useful in pre-prod\n" +
			"where the synthetic addresses don't route yet). -o json emits\n" +
			"the structured Result objects so CI can assert against them.",
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			if ctx == nil {
				ctx = context.Background()
			}
			cfg, _ := config.LoadOrDefault(envFile)

			baseURL := ""
			if cfg != nil && cfg.PolarisAPIHostname != "" {
				baseURL = "https://" + cfg.PolarisAPIHostname
			}
			if envURL := os.Getenv("POLARIS_API_BASE_URL"); envURL != "" {
				baseURL = envURL
			}
			if baseURL == "" {
				return errors.New("no API base URL: set POLARIS_API_HOSTNAME in .env.deploy or POLARIS_API_BASE_URL in env")
			}

			cli, clientErr := loadAdminClient(baseURL, bootstrapOutput)
			if clientErr != nil {
				// Non-fatal: the admin + synthetic checks will skip;
				// healthz still runs.
				fmt.Fprintf(cmd.ErrOrStderr(), "warning: %v\n", clientErr)
			}

			scfg := smoke.Config{
				APIBaseURL:    baseURL,
				APIClient:     cli,
				SyntheticFrom: cfg.SyntheticFrom,
				SyntheticTo:   cfg.SyntheticTo,
				SkipSynthetic: skipSynthetic,
				PollInterval:  time.Duration(pollIntervalMS) * time.Millisecond,
				PollTimeout:   time.Duration(pollTimeoutS) * time.Second,
			}

			isJSON := outputFmt == "json"
			isYAML := outputFmt == "yaml"

			var results []smoke.Result
			if isJSON || isYAML || !isInteractiveStdin() {
				// Non-TTY / structured output: run sequentially, no TUI.
				results = smoke.RunAll(ctx, scfg)
			} else {
				results = runSmokeWithTUI(ctx, cmd.OutOrStdout(), scfg)
			}

			switch {
			case isJSON:
				if err := json.NewEncoder(cmd.OutOrStdout()).Encode(results); err != nil {
					return err
				}
			case isYAML:
				if err := output.EmitYAML(cmd.OutOrStdout(), results); err != nil {
					return err
				}
			default:
				renderSmokeTable(cmd.OutOrStdout(), results)
			}

			if smoke.AnyFailed(results) {
				return errors.New("smoke: one or more checks failed")
			}
			return nil
		},
	}
	c.Flags().StringVar(&envFile, "env-file", defaultEnvFile, "path to .env.deploy")
	c.Flags().StringVar(&bootstrapOutput, "bootstrap-output", defaultBootstrapOutput, "path to .bootstrap-output.json")
	c.Flags().BoolVar(&skipSynthetic, "skip-synthetic", false, "skip the synthetic-outbound check")
	c.Flags().StringVarP(&outputFmt, "output", "o", "table", "output format: table|json|yaml")
	c.Flags().IntVar(&pollIntervalMS, "poll-interval-ms", 5000, "poll interval between status checks (ms)")
	c.Flags().IntVar(&pollTimeoutS, "poll-timeout-s", 60, "max time to wait for the synthetic message to deliver (s)")
	return c
}

// loadAdminClient builds the signed-request client from
// .bootstrap-output.json. Returns (nil, err) if the file is missing or
// malformed — the caller treats that as a soft warning so healthz can
// still run.
func loadAdminClient(baseURL, path string) (*client.Client, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	var bo bootstrapOutput
	if err := json.Unmarshal(data, &bo); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if bo.AdminKeyID == "" || bo.AdminKeySecret == "" {
		return nil, fmt.Errorf("%s missing admin_key_id or admin_key_secret", path)
	}
	return client.New(baseURL, bo.AdminKeyID, bo.AdminKeySecret), nil
}

// renderSmokeTable prints the three Result rows in a human-readable
// table. Status colour is best-effort — operators on dumb terminals
// still see plain text.
func renderSmokeTable(w io.Writer, results []smoke.Result) {
	t := &output.Table{Headers: []string{"CHECK", "STATUS", "TIME", "DETAIL"}}
	for _, r := range results {
		t.Rows = append(t.Rows, []string{
			r.Name,
			strings.ToUpper(r.Status),
			r.Duration.Round(time.Millisecond).String(),
			r.Detail,
		})
	}
	_ = t.Render(w)
}

// --- TUI runner ------------------------------------------------------

// runSmokeWithTUI runs the checks sequentially, pushing each result
// into a Bubble Tea program that renders a live three-row table.
// Returns the collected results.
func runSmokeWithTUI(ctx context.Context, out io.Writer, cfg smoke.Config) []smoke.Result {
	rep := newSmokeTUIReporter(out)
	defer rep.Done()

	// Pre-seed the table with "pending" rows so the user sees the full
	// list immediately.
	rep.Init([]string{"healthz", "admin-status", "synthetic-outbound"})

	var results []smoke.Result
	for _, run := range []func(context.Context, smoke.Config) smoke.Result{
		smoke.CheckHealthz,
		smoke.CheckAdminStatus,
		smoke.CheckSyntheticOutbound,
	} {
		r := run(ctx, cfg)
		results = append(results, r)
		rep.Update(r)
	}
	return results
}

// smokeTUIReporter drives a Bubble Tea program that renders a live
// table with one row per check.
type smokeTUIReporter struct {
	prog   *tea.Program
	wg     sync.WaitGroup
	closed sync.Once
}

func newSmokeTUIReporter(out io.Writer) *smokeTUIReporter {
	cols := []table.Column{
		{Title: "CHECK", Width: 22},
		{Title: "STATUS", Width: 10},
		{Title: "TIME", Width: 10},
		{Title: "DETAIL", Width: 40},
	}
	tbl := table.New(
		table.WithColumns(cols),
		table.WithFocused(false),
		table.WithHeight(5),
	)
	st := table.DefaultStyles()
	st.Header = st.Header.
		BorderStyle(lipgloss.NormalBorder()).
		BorderForeground(lipgloss.Color("240")).
		BorderBottom(true).Bold(true)
	tbl.SetStyles(st)
	m := smokeTUIModel{tbl: tbl, headerStyle: lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("39"))}
	prog := tea.NewProgram(m, tea.WithOutput(out))
	r := &smokeTUIReporter{prog: prog}
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		_, _ = prog.Run()
	}()
	return r
}

func (r *smokeTUIReporter) Init(names []string) { r.prog.Send(smokeInitMsg{names: names}) }
func (r *smokeTUIReporter) Update(res smoke.Result) {
	r.prog.Send(smokeUpdateMsg{result: res})
}
func (r *smokeTUIReporter) Done() {
	r.closed.Do(func() {
		r.prog.Send(smokeDoneMsg{})
		r.prog.Quit()
		r.wg.Wait()
	})
}

type smokeInitMsg struct{ names []string }
type smokeUpdateMsg struct{ result smoke.Result }
type smokeDoneMsg struct{}

type smokeTUIModel struct {
	tbl         table.Model
	rows        []table.Row
	finished    bool
	headerStyle lipgloss.Style
}

func (m smokeTUIModel) Init() tea.Cmd { return nil }

func (m smokeTUIModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch v := msg.(type) {
	case tea.KeyMsg:
		if k := v.String(); k == "ctrl+c" || k == "q" {
			return m, tea.Quit
		}
	case smokeInitMsg:
		m.rows = make([]table.Row, len(v.names))
		for i, n := range v.names {
			m.rows[i] = table.Row{n, "PENDING", "", ""}
		}
		m.tbl.SetRows(m.rows)
		return m, nil
	case smokeUpdateMsg:
		for i, row := range m.rows {
			if row[0] == v.result.Name {
				m.rows[i] = table.Row{
					v.result.Name,
					strings.ToUpper(v.result.Status),
					v.result.Duration.Round(time.Millisecond).String(),
					v.result.Detail,
				}
				break
			}
		}
		m.tbl.SetRows(m.rows)
		return m, nil
	case smokeDoneMsg:
		m.finished = true
		return m, tea.Quit
	}
	return m, nil
}

func (m smokeTUIModel) View() string {
	var b strings.Builder
	b.WriteString(m.headerStyle.Render("polaris-email — smoke checks"))
	b.WriteString("\n\n")
	b.WriteString(m.tbl.View())
	b.WriteString("\n")
	return b.String()
}
