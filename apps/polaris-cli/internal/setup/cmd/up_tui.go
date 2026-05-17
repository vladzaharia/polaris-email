package cmd

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/mattn/go-isatty"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/tui"
)

// upTUITimeout caps how long the post-up probe loop runs before the
// model is force-quit. Mirrors the verify-flow timeout the spec calls
// out — operators get a clear "probes did not settle in 60s" signal
// rather than a hung TUI.
const upTUITimeout = 60 * time.Second

// titleAware is satisfied by setup.Input wrappers that can surface the
// bridge name + image tag + mode for the TUI title bar. The bridge's
// inputWrapper satisfies this interface — daemons without one fall
// back to the daemon name / blank image / mode-string.
type titleAware interface {
	Identifier() string
}

// imageTagAware is satisfied by inputs that expose their image tag for
// display. The bridge input's wrapper does not expose it directly, so
// we read it via a small interface to keep the cmd package free of a
// bridge-specific import.
type imageTagAware interface {
	ImageTag() string
}

// titleFor returns a sensible default title-bar metadata bundle for the
// supplied daemon + input. Best-effort: anything not exposed falls back
// to a blank.
func titleFor(d setup.Daemon, in setup.Input) tui.ComposeLogsTitle {
	t := tui.ComposeLogsTitle{Name: d.Name(), Mode: in.Mode()}
	if w, ok := in.(titleAware); ok {
		if id := w.Identifier(); id != "" {
			t.Name = id
		}
	}
	if w, ok := in.(imageTagAware); ok {
		t.ImageTag = w.ImageTag()
	}
	return t
}

// shouldUseTUI decides between the live TUI and the plain-stdout
// fallback. Order:
//
//  1. --non-interactive flag wins (operator-supplied).
//  2. POLARIS_NO_TUI=1 disables (CI/Codespaces escape hatch).
//  3. Stdout must be a TTY.
//
// The non-TTY fall-through keeps CI pipelines silent-on-success.
func shouldUseTUI(nonInteractive bool) bool {
	if nonInteractive {
		return false
	}
	if v := os.Getenv("POLARIS_NO_TUI"); v == "1" || v == "true" {
		return false
	}
	return isatty.IsTerminal(os.Stdout.Fd()) || isatty.IsCygwinTerminal(os.Stdout.Fd())
}

// runUpWithTUI is the TUI-enhanced replacement for the plain Up() flow
// in the cobra `up` leaf. It runs `docker compose up -d` synchronously
// via the descriptor's Lifecycle.Up, then spawns `docker compose logs
// -f --since 30s` for live tailing while the descriptor's PostUpProbes
// run in a sibling goroutine. The Bubble Tea program owns the terminal
// for the duration; the function blocks until the program exits.
//
// Returns the first probe-fail error (if any) or nil on full success.
// A 60s timeout protects against probes that never settle.
func runUpWithTUI(ctx context.Context, d setup.Daemon, in setup.Input, profiles []string, out io.Writer) error {
	lc, _ := d.(setup.Lifecycle)
	if lc == nil {
		return fmt.Errorf("setup %s: daemon does not implement Lifecycle", d.Name())
	}
	dir := dirFromInput(in, "")
	if dir == "" {
		return fmt.Errorf("setup %s: input does not expose a project directory", d.Name())
	}

	// Stage 1: `docker compose up -d`. Suppress its output (the TUI
	// owns the screen for the rest of the run). Surface any error
	// before kicking off the TUI — a failed pull/up is best reported
	// inline.
	if err := lc.Up(ctx, in, profiles, io.Discard); err != nil {
		return err
	}

	// Build the TUI model with the descriptor's probe names pre-seeded
	// so the bottom panel paints the full list immediately.
	probes := d.PostUpProbes(in)
	probeNames := make([]string, len(probes))
	for i, p := range probes {
		probeNames[i] = p.Name
	}
	model := tui.NewComposeLogsModel(titleFor(d, in), probeNames)
	prog := tea.NewProgram(model, tea.WithOutput(out))

	// Stage 2: tail `docker compose logs -f` in a goroutine. The
	// process is killed when the TUI exits — we don't leak children.
	logCtx, cancelLogs := context.WithCancel(ctx)
	defer cancelLogs()
	logCmd := exec.CommandContext(logCtx, "docker", "compose", "--project-directory", dir, "logs", "-f", "--since", "30s")
	stdoutPipe, _ := logCmd.StdoutPipe()
	stderrPipe, _ := logCmd.StderrPipe()
	if err := logCmd.Start(); err != nil {
		// Falling through with a banner line is friendlier than hard-
		// failing: probes still report; the operator just loses live
		// logs. This commonly bites operators who removed `docker logs`
		// capability inside hardened sandboxes.
		go func() {
			prog.Send(tui.ComposeLogLineMsg{Line: fmt.Sprintf("(could not start log tailer: %v)", err)})
		}()
	} else {
		go pumpLines(stdoutPipe, prog)
		go pumpLines(stderrPipe, prog)
	}

	// Stage 3: run probes in a goroutine and surface each result.
	probeCtx, cancelProbes := context.WithTimeout(ctx, upTUITimeout)
	defer cancelProbes()
	var probeErr error
	var probeWG sync.WaitGroup
	probeWG.Add(1)
	go func() {
		defer probeWG.Done()
		prog.Send(tui.ComposeStateMsg{State: tui.ComposeStateVerifying})
		var anyFail bool
		for _, p := range probes {
			select {
			case <-probeCtx.Done():
				prog.Send(tui.BridgeProbeResultMsg{
					Name: p.Name, Status: "fail",
					Detail: fmt.Sprintf("timed out after %s", upTUITimeout),
				})
				if probeErr == nil {
					probeErr = fmt.Errorf("probe %s timed out", p.Name)
				}
				anyFail = true
				continue
			default:
			}
			r := p.Run(probeCtx)
			prog.Send(tui.BridgeProbeResultMsg{Name: p.Name, Status: r.Status, Detail: r.Detail})
			if r.Status == "fail" {
				if probeErr == nil {
					probeErr = fmt.Errorf("probe %s failed: %s", p.Name, r.Detail)
				}
				anyFail = true
			}
		}
		if anyFail {
			prog.Send(tui.ComposeStateMsg{State: tui.ComposeStateFailed})
		} else {
			prog.Send(tui.ComposeStateMsg{State: tui.ComposeStateHealthy})
			// Auto-quit after a short pause so operators see the
			// final state before the screen tears down. 1.5s mirrors
			// the existing infra-apply TUI behaviour.
			time.AfterFunc(1500*time.Millisecond, func() {
				prog.Send(tui.ComposeStateMsg{State: tui.ComposeStateDone})
			})
		}
	}()

	// Block on the TUI. Any error returned from prog.Run() is the
	// terminal failing to enter raw mode (rare) — surface it.
	if _, err := prog.Run(); err != nil {
		probeWG.Wait()
		return fmt.Errorf("compose-logs TUI: %w", err)
	}

	cancelLogs()
	probeWG.Wait()

	// Best-effort: drain the log subprocess. We already cancelled the
	// context so this is non-blocking.
	if logCmd.Process != nil {
		_ = logCmd.Wait()
	}
	if probeErr != nil {
		return probeErr
	}
	if err := probeCtx.Err(); err != nil && !errors.Is(err, context.Canceled) {
		return err
	}
	return nil
}

// pumpLines scans one of the docker-compose subprocess pipes and sends
// a ComposeLogLineMsg per line into the Bubble Tea program. Closes when
// the pipe EOFs or the parent cancels the context.
func pumpLines(r io.ReadCloser, prog *tea.Program) {
	defer r.Close()
	sc := bufio.NewScanner(r)
	// Docker logs frequently produce long lines (stack traces, embedded
	// JSON). Bump the buffer from the default 64KiB to 1MiB so the
	// scanner does not error out mid-line.
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		prog.Send(tui.ComposeLogLineMsg{Line: sc.Text()})
	}
}
