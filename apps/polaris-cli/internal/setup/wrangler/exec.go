// Package wrangler is a thin subprocess wrapper around the `wrangler`
// CLI. The setup flow only shells out to wrangler for two things:
// `wrangler deploy` (Worker deploys) and `wrangler d1 migrations apply`
// (D1 schema sync). Every other CF API call goes through the
// internal/setup/cfapi package directly.
package wrangler

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
)

// Binary is the executable name we look up in PATH. Tests can override
// it (via t.Setenv("PATH", ...) trick) to point at a stub script.
const Binary = "wrangler"

// ErrNotInstalled is returned by Run / Detect when the wrangler binary
// is missing from PATH.
var ErrNotInstalled = errors.New("wrangler not found in PATH; install with `pnpm i -g wrangler@4`")

// Result captures the outputs of a single wrangler invocation. Stdout
// and Stderr are buffered in full — the setup flow's wrangler commands
// are short-lived (deploys complete in <30s) so the memory cost is
// negligible compared to the operator-visibility win.
type Result struct {
	Stdout   []byte
	Stderr   []byte
	ExitCode int
}

// Run executes `wrangler <args...>` and waits for completion. The
// returned error is non-nil whenever the process did not exit with code
// 0 or whenever it couldn't be launched at all; in both cases the
// *Result is still populated (when reachable) so callers can surface
// wrangler's own error text to the operator.
//
// ctx controls the deadline; if it fires the subprocess is killed.
func Run(ctx context.Context, args ...string) (*Result, error) {
	return RunWith(ctx, Binary, nil, args...)
}

// RunWith is the lower-level entry point that lets the caller override
// the binary name and pipe extra stdin. The setup flow uses Run; this
// is here mainly to keep exec_test.go honest.
func RunWith(ctx context.Context, binary string, stdin io.Reader, args ...string) (*Result, error) {
	if _, err := exec.LookPath(binary); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrNotInstalled, err)
	}
	cmd := exec.CommandContext(ctx, binary, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if stdin != nil {
		cmd.Stdin = stdin
	}

	runErr := cmd.Run()
	res := &Result{Stdout: stdout.Bytes(), Stderr: stderr.Bytes()}
	if cmd.ProcessState != nil {
		res.ExitCode = cmd.ProcessState.ExitCode()
	}
	if runErr != nil {
		// Surface the exit code in the error for easier debugging.
		var exitErr *exec.ExitError
		if errors.As(runErr, &exitErr) {
			return res, fmt.Errorf("wrangler %v: exit %d: %s",
				args, res.ExitCode, truncateForError(res.Stderr))
		}
		return res, fmt.Errorf("wrangler %v: %w", args, runErr)
	}
	return res, nil
}

func truncateForError(b []byte) string {
	const maxLen = 300
	s := string(bytes.TrimSpace(b))
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}
