package cmds

import (
	"context"
	"fmt"
	"os"
	"runtime/debug"
	"time"

	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/upgrader"
)

// Version is set by goreleaser via ldflags; falls back to debug.BuildInfo.
var (
	Version = "dev"
	Commit  = "none"
	Date    = "unknown"
)

// newVersionCmd is the parent command. Bare `polaris-email version`
// prints a multi-line status block: build banner + channel + install
// method + last-check status. Subcommands `upgrade` and `channel`
// ride underneath for the explicit-action verbs.
func newVersionCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "version",
		Short: "Print build version, channel, install method, and update status",
		RunE: func(cmd *cobra.Command, _ []string) error {
			info, _ := debug.ReadBuildInfo()
			gv := ""
			if info != nil {
				gv = info.GoVersion
			}
			fmt.Fprintf(Out, "polaris-email %s (commit %s, built %s, %s)\n", Version, Commit, Date, gv)

			// Best-effort: surface channel + install method + update
			// status. Network/state errors are non-fatal — `version`
			// must never block on a flaky GitHub API.
			dir, err := upgrader.DefaultStateDir()
			if err != nil {
				return nil
			}
			state, err := upgrader.LoadState(dir)
			if err != nil {
				return nil
			}
			method, _ := upgrader.DetectInstallMethod(dir, Version)
			channel := upgrader.ResolveChannel(state.Channel, method)
			origin := "explicit"
			if state.Channel == "" {
				origin = "default (via install method)"
			}
			fmt.Fprintf(Out, "\nchannel:        %s  (%s)\n", channel, origin)
			fmt.Fprintf(Out, "install method: %s\n", method)

			// Refresh the cache if it's stale, so `pml version`
			// surfaces a recent check without forcing the operator to
			// run `version upgrade` first. Same 1h throttle every
			// other check uses — calling `version` repeatedly inside
			// the window doesn't re-hit GitHub.
			ctx, cancel := context.WithTimeout(cmd.Context(), 3*time.Second)
			defer cancel()
			if ctx.Err() != nil || cmd.Context() == nil {
				ctx, cancel = context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
			}
			upd, newState, _ := upgrader.OpportunisticCheck(ctx, channel, Version, state)
			if !newState.LastCheck.Equal(state.LastCheck) {
				// Persist only on a real check; a throttled no-op
				// shouldn't touch the file.
				_ = upgrader.SaveState(dir, newState)
				state = newState
			}

			renderUpdateStatus(channel, state, upd)
			return nil
		},
	}
	c.AddCommand(newVersionUpgradeCmd(), newVersionChannelCmd())
	return c
}

// renderUpdateStatus prints the "last checked" + "update available"
// lines below the channel block. State carries the cached result, and
// `upd` is the just-resolved Update from this invocation (nil when
// throttled, up-to-date, OR when the channel doesn't support remote
// resolution at all — the local channel).
func renderUpdateStatus(channel upgrader.Channel, state upgrader.State, justChecked *upgrader.Update) {
	if channel == upgrader.ChannelLocal {
		// Local channel rebuilds from a sibling checkout — no remote
		// tag to compare against. The "is there an update?" question
		// answers "run `version upgrade` to rebuild from main"; we
		// don't bother running a check here.
		fmt.Fprintln(Out, "update:         local channel — run `polaris-email version upgrade` to rebuild from your checkout")
		return
	}
	if state.LastCheck.IsZero() {
		fmt.Fprintln(Out, "last check:     (never)")
		return
	}
	age := time.Since(state.LastCheck).Round(time.Second)
	fmt.Fprintf(Out, "last check:     %s (%s ago)\n",
		state.LastCheck.Local().Format("2006-01-02 15:04:05"),
		age,
	)
	// Prefer the just-checked result when present (this invocation
	// did the network call); fall back to the cached LastCheckResult
	// otherwise.
	switch {
	case justChecked != nil:
		fmt.Fprintf(Out, "update:         %s -> %s available\n",
			justChecked.CurrentVersion, justChecked.LatestVersion)
		fmt.Fprintln(Out, "                (run `polaris-email version upgrade` to install)")
	case state.LastCheckResult != nil:
		fmt.Fprintf(Out, "update:         %s -> %s available (cached)\n",
			state.LastCheckResult.CurrentVersion, state.LastCheckResult.LatestVersion)
		fmt.Fprintln(Out, "                (run `polaris-email version upgrade` to install)")
	default:
		fmt.Fprintln(Out, "update:         up-to-date")
	}
}

// newVersionUpgradeCmd runs an explicit upgrade. Skips the launch-time
// throttle window — operators who type `pml version upgrade` mean it.
func newVersionUpgradeCmd() *cobra.Command {
	var dryRun bool
	c := &cobra.Command{
		Use:   "upgrade",
		Short: "Check for + install a newer polaris-email binary",
		Long: `Resolves the operator's chosen channel (stable / dev / local),
detects the install method (brew / curl / local-repo), and runs the
appropriate upgrade. Stable + dev download a tarball from GitHub
Releases; brew shells out to ` + "`brew upgrade`" + `; local rebuilds
from the operator's checkout via ` + "`make build`" + `.

This command skips the 1h launch-time throttle.`,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			if ctx == nil {
				ctx = context.Background()
			}

			dir, err := upgrader.DefaultStateDir()
			if err != nil {
				return err
			}
			state, err := upgrader.LoadState(dir)
			if err != nil {
				return err
			}
			// Resolve channel through install-method-aware defaulting:
			// a `make build` binary defaults to the `local` channel
			// even when state.Channel is empty, so the upgrade doesn't
			// silently swap in a stable tarball over the operator's
			// in-flight work.
			method, _ := upgrader.DetectInstallMethod(dir, Version)
			channel := upgrader.ResolveChannel(state.Channel, method)

			upd, err := upgrader.CheckLatest(ctx, channel, Version)
			if err != nil {
				return err
			}
			if upd == nil {
				fmt.Fprintf(Out, "polaris-email %s is up-to-date (channel: %s).\n", Version, channel)
				return nil
			}
			fmt.Fprintf(Out, "polaris-email %s → %s on channel %s\n", upd.CurrentVersion, upd.LatestVersion, channel)
			if dryRun {
				fmt.Fprintln(Out, "(dry-run: not installing)")
				return nil
			}

			progress := func(p upgrader.Progress) {
				if p.BytesTotal > 0 {
					fmt.Fprintf(os.Stderr, "[upgrade] %s %d/%d\n", p.Stage, p.BytesDone, p.BytesTotal)
				} else if p.Message != "" {
					fmt.Fprintf(os.Stderr, "[upgrade] %s: %s\n", p.Stage, p.Message)
				}
			}
			if err := upgrader.Install(ctx, upd, method, progress); err != nil {
				return err
			}
			fmt.Fprintf(Out, "Installed polaris-email %s.\n", upd.LatestVersion)
			// Re-exec into the new binary so the operator's next
			// command runs against the latest code. On Windows this is
			// a no-op + stderr notice (see reexec_windows.go).
			return upgrader.ReExec("")
		},
	}
	c.Flags().BoolVar(&dryRun, "dry-run", false, "check + print only; don't install")
	return c
}

// newVersionChannelCmd groups the channel inspect / set / list verbs.
func newVersionChannelCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "channel",
		Short: "Inspect or change the upgrader's release channel",
		RunE: func(_ *cobra.Command, _ []string) error {
			dir, err := upgrader.DefaultStateDir()
			if err != nil {
				return err
			}
			state, err := upgrader.LoadState(dir)
			if err != nil {
				return err
			}
			method, _ := upgrader.DetectInstallMethod(dir, Version)
			ch := upgrader.ResolveChannel(state.Channel, method)
			origin := "explicit"
			if state.Channel == "" {
				origin = "default (via install method)"
			}
			fmt.Fprintf(Out, "channel:        %s  (%s)\n", ch, origin)
			fmt.Fprintf(Out, "install method: %s\n", method)
			fmt.Fprintf(Out, "current binary: %s\n", Version)
			return nil
		},
	}
	c.AddCommand(newVersionChannelSetCmd(), newVersionChannelListCmd())
	return c
}

func newVersionChannelSetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "set <stable|dev|local>",
		Short: "Pick an update channel; persisted in ~/.config/polaris-email/upgrader-state.json",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			ch, err := upgrader.ParseChannel(args[0])
			if err != nil {
				return err
			}
			dir, err := upgrader.DefaultStateDir()
			if err != nil {
				return err
			}
			state, err := upgrader.LoadState(dir)
			if err != nil {
				return err
			}
			state.Channel = string(ch)
			if err := upgrader.SaveState(dir, state); err != nil {
				return err
			}
			fmt.Fprintf(Out, "channel set to %s.\n", ch)
			return nil
		},
	}
}

func newVersionChannelListCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "Enumerate every channel + how it resolves",
		RunE: func(_ *cobra.Command, _ []string) error {
			fmt.Fprintln(Out, "channel  source")
			fmt.Fprintln(Out, "-------  ------")
			fmt.Fprintln(Out, "stable   GitHub Releases /latest")
			fmt.Fprintln(Out, "dev      GitHub Releases /tags/dev (force-replaced on every main push)")
			fmt.Fprintln(Out, "local    sibling polaris-email checkout (rebuilt via make build)")
			return nil
		},
	}
}
