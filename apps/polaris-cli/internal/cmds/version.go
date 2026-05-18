package cmds

import (
	"context"
	"fmt"
	"os"
	"runtime/debug"

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
// keeps the historical behaviour (print one-line banner); the
// `upgrade` and `channel` subcommands ride underneath.
func newVersionCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "version",
		Short: "Print build version + manage CLI upgrades",
		RunE: func(_ *cobra.Command, _ []string) error {
			info, _ := debug.ReadBuildInfo()
			gv := ""
			if info != nil {
				gv = info.GoVersion
			}
			fmt.Fprintf(Out, "polaris-email %s (commit %s, built %s, %s)\n", Version, Commit, Date, gv)
			return nil
		},
	}
	c.AddCommand(newVersionUpgradeCmd(), newVersionChannelCmd())
	return c
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
			channel, err := upgrader.ParseChannel(state.Channel)
			if err != nil {
				return err
			}

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

			method, _ := upgrader.DetectInstallMethod(dir)
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
			ch, _ := upgrader.ParseChannel(state.Channel)
			method, _ := upgrader.DetectInstallMethod(dir)
			fmt.Fprintf(Out, "channel:        %s\n", ch)
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
