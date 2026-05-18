package cmds

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/upgrader"
)

// skippedCommandPaths is the set of command paths that NEVER get the
// blocking upgrade check. Either because they ARE the upgrade flow
// (version) and would recurse, or because they own their own progress
// UI (TUI, setup-phase commands) and don't want a second progress bar
// stomping on theirs.
//
// `polaris-email` with no subcommand is the bare TUI entry point — it
// shows up here as the root's Use value.
var skippedCommandPaths = map[string]struct{}{
	"polaris-email":             {},
	"polaris-email tui":         {},
	"polaris-email serve":       {},
	"polaris-email version":     {},
	"polaris-email setup":       {},
	"polaris-email setup infra": {},
	"polaris-email completion":  {},
	"polaris-email help":        {},
}

// shouldSkipUpgradeCheck returns true if the running cobra command is
// one of the paths above (or a descendant of one). The CommandPath()
// helper returns the full space-separated lineage (e.g.
// "polaris-email setup infra apply"), which we prefix-match against the
// skip set so every subcommand under `setup` inherits the skip too.
func shouldSkipUpgradeCheck(cmd *cobra.Command) bool {
	if cmd == nil {
		return true
	}
	path := cmd.CommandPath()
	for skip := range skippedCommandPaths {
		if path == skip || strings.HasPrefix(path, skip+" ") {
			return true
		}
	}
	return false
}

// maybeUpgrade runs the opportunistic check; if an update is available,
// it blocks with a stderr progress feed, installs, then re-execs into
// the new binary. Network errors are swallowed — they shouldn't block
// the operator's actual command. The downstream command then runs
// against the just-installed binary.
//
// Caller has already filtered out the no-check command paths via
// shouldSkipUpgradeCheck.
func maybeUpgrade(_ *cobra.Command) {
	dir, err := upgrader.DefaultStateDir()
	if err != nil {
		return
	}
	state, err := upgrader.LoadState(dir)
	if err != nil {
		return
	}
	channel, err := upgrader.ParseChannel(state.Channel)
	if err != nil {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	upd, newState, _ := upgrader.OpportunisticCheck(ctx, channel, Version, state)
	// Always persist the LastCheck advance, even on error — see
	// upgrader.OpportunisticCheck's comment.
	_ = upgrader.SaveState(dir, newState)
	if upd == nil {
		return
	}

	method, _ := upgrader.DetectInstallMethod(dir)

	// Print an orange-bordered notice to stderr. ANSI 38;5;215 is a
	// peach close to Catppuccin macchiato Peach (#f5a97f) — same shade
	// the TUI infobox uses. Plain ASCII border so we never break a
	// non-UTF8 terminal.
	fmt.Fprintln(os.Stderr, peachLine("+--- polaris-email upgrade ----------------------------------+"))
	fmt.Fprintln(os.Stderr, peachLine(fmt.Sprintf("| %-58s |", upd.CurrentVersion+" -> "+upd.LatestVersion+" ("+string(channel)+" channel)")))
	fmt.Fprintln(os.Stderr, peachLine("+------------------------------------------------------------+"))

	installCtx, installCancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer installCancel()
	if err := upgrader.Install(installCtx, upd, method, stderrProgress); err != nil {
		fmt.Fprintln(os.Stderr, peachLine("|  upgrade failed: "+err.Error()))
		fmt.Fprintln(os.Stderr, peachLine("|  continuing with old binary"))
		return
	}

	// Re-exec — on POSIX this replaces the running process so the
	// operator's command runs against the new binary. On Windows we
	// print a notice (the new binary is staged at <path>.new).
	_ = upgrader.ReExec("")
}

// stderrProgress renders a simple textual progress feed. The TUI gets
// the orange-bordered Bubble version of this same data via the
// upgradenotice package.
func stderrProgress(p upgrader.Progress) {
	switch p.Stage {
	case upgrader.StageDownload:
		if p.BytesTotal > 0 {
			pct := int(p.BytesDone * 100 / p.BytesTotal)
			fmt.Fprintf(os.Stderr, "\r[upgrade] download %3d%% (%d/%d bytes)", pct, p.BytesDone, p.BytesTotal)
			if p.BytesDone == p.BytesTotal {
				fmt.Fprintln(os.Stderr)
			}
		}
	case upgrader.StageVerify:
		fmt.Fprintln(os.Stderr, "[upgrade] verifying sha256")
	case upgrader.StageExtract:
		if p.Message != "" {
			fmt.Fprintf(os.Stderr, "[upgrade] extract: %s\n", p.Message)
		}
	case upgrader.StageReplace:
		fmt.Fprintln(os.Stderr, "[upgrade] replacing binary")
	case upgrader.StageBrewHandoff:
		fmt.Fprintln(os.Stderr, "[upgrade] handing off to brew")
	case upgrader.StageDone:
		fmt.Fprintln(os.Stderr, "[upgrade] done")
	}
}

// peachLine wraps a string in ANSI 256-color peach (215) — a close
// match to Catppuccin macchiato Peach (#f5a97f). No-op when stderr
// isn't a TTY (operator piping `polaris-email ... 2>&1 | something`
// won't get embedded escapes in their pipe).
func peachLine(s string) string {
	if !isStderrTTY() {
		return s
	}
	return "\x1b[38;5;215m" + s + "\x1b[0m"
}

// isStderrTTY returns true when os.Stderr is a terminal. We don't
// import x/term here to keep the dep set small — checking the file
// mode bits is enough: a terminal has the ModeCharDevice bit set,
// pipes / redirected files don't.
func isStderrTTY() bool {
	fi, err := os.Stderr.Stat()
	if err != nil {
		return false
	}
	return fi.Mode()&os.ModeCharDevice != 0
}
