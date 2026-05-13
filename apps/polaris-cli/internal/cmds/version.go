package cmds

import (
	"fmt"
	"runtime/debug"

	"github.com/spf13/cobra"
)

// Version is set by goreleaser via ldflags; falls back to debug.BuildInfo.
var (
	Version = "dev"
	Commit  = "none"
	Date    = "unknown"
)

func newVersionCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Print build version",
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
}
