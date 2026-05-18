//go:build !windows

package upgrader

import (
	"fmt"
	"os"
	"syscall"
)

// ReExec replaces the current process image with the binary at path,
// passing the original argv + environment. On success this function
// does NOT return — execve(2) takes over.
//
// Used after a successful upgrade to ensure subsequent code runs
// against the new binary (CLI subcommand path) or to relaunch the TUI
// once the restart-countdown finishes.
func ReExec(path string) error {
	if path == "" {
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		path = exe
	}
	if err := syscall.Exec(path, os.Args, os.Environ()); err != nil {
		return fmt.Errorf("upgrader: exec %s: %w", path, err)
	}
	return nil // unreachable
}
