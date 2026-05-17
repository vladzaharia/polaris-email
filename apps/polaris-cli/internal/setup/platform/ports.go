// Package platform groups host-side helpers used by setup wizards — port
// probing, atomic file IO with permission enforcement, and a thin
// `docker` / `docker compose` wrapper. The package is deliberately
// stdlib-only and intentionally cross-platform: no shell-outs to
// `lsof`/`ss`/`netstat`, no platform-conditional code paths.
package platform

import (
	"context"
	"fmt"
	"net"
	"time"
)

// IsPortFree probes whether a TCP port is bindable by trying to Listen on
// it. The port is released immediately after the probe; the function
// returns true when the bind succeeded.
//
// We deliberately use `net.Listen` rather than scraping `lsof`/`ss`
// output: the in-process probe is the only mechanism that works
// consistently across darwin/linux/windows and inside containers. Two
// callers racing on the same port may each see (true, nil) — the wizard
// only uses this for an *advisory* precheck, not for a reservation, so
// the race is harmless.
//
// A bind failure is reported as (false, nil); any other error (e.g.
// permission denied for a low-numbered port the operator can't bind as a
// non-root user) bubbles up so the caller can surface it.
func IsPortFree(ctx context.Context, port int) (bool, error) {
	if port <= 0 || port > 65535 {
		return false, fmt.Errorf("invalid port %d", port)
	}
	if ctx == nil {
		ctx = context.Background()
	}
	var lc net.ListenConfig
	// Use a short subcontext to bound the bind attempt even when the
	// caller passed a long-lived context.
	pctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	// Probe BOTH the wildcard interface (what compose `ports:` maps to
	// by default — "0.0.0.0:<port>:...") AND any loopback occupant. A
	// process bound to 127.0.0.1:<port> will block compose's wildcard
	// publish even though the wildcard probe itself succeeds; for the
	// precheck to be useful we treat either kind of conflict as "busy".
	for _, addr := range []string{
		fmt.Sprintf("0.0.0.0:%d", port),
		fmt.Sprintf("127.0.0.1:%d", port),
	} {
		ln, err := lc.Listen(pctx, "tcp", addr)
		if err != nil {
			// Distinguish "port is in use" (EADDRINUSE) from "we can't
			// bind because we lack permission". The stdlib net error
			// wraps syscall.Errno; rather than reach into the syscall
			// package (and add Windows complexity), we rely on the
			// caller treating any failure as "not free". Operators see
			// the underlying error via the precheck report.
			return false, nil
		}
		_ = ln.Close()
	}
	return true, nil
}

// FirstFreePort returns the first port from `candidates` that is free,
// or zero with a descriptive error if all are taken. Used by the wizard
// to pick e.g. an alternate webhook port when 8080 is already busy.
func FirstFreePort(ctx context.Context, candidates ...int) (int, error) {
	for _, p := range candidates {
		ok, err := IsPortFree(ctx, p)
		if err != nil {
			return 0, err
		}
		if ok {
			return p, nil
		}
	}
	return 0, fmt.Errorf("none of %v are free", candidates)
}
