package secrets

import (
	"context"
	"fmt"
	"strings"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/wrangler"
)

// Pusher abstracts the wrangler subprocess so tests can swap a fake.
// The real implementation runs `wrangler secret put <NAME> --name
// <worker>` with the value piped on stdin.
type Pusher interface {
	Push(ctx context.Context, svc, name, value string) error
}

// WranglerPusher is the production Pusher. workerName resolves the
// service short-name (api, out, in, panel, ...) to the wrangler-side
// Worker name. When nil, the service short-name is used verbatim — that
// matches our current convention where the Worker is named after the
// service directory.
type WranglerPusher struct {
	WorkerName func(svc string) string
}

// Push implements Pusher.
func (p WranglerPusher) Push(ctx context.Context, svc, name, value string) error {
	worker := svc
	if p.WorkerName != nil {
		worker = p.WorkerName(svc)
	}
	return pushWith(ctx, wrangler.Binary, worker, name, value)
}

// pushWith is the lower-level entry point used by both the production
// pusher and exec_test stubs. It shells out via wrangler.RunWith so the
// subprocess plumbing (PATH check, exit-code surfacing) stays in one
// place.
//
// wrangler reads the secret value from stdin when invoked
// non-interactively, so we pipe `value` straight in. `value` is not
// logged anywhere; the wrangler invocation only sees it via the stdin
// pipe.
func pushWith(ctx context.Context, binary, worker, name, value string) error {
	if name == "" {
		return fmt.Errorf("secrets: push: secret name required")
	}
	if worker == "" {
		return fmt.Errorf("secrets: push: worker name required for secret %s", name)
	}
	r, err := wrangler.RunWith(ctx, binary, strings.NewReader(value),
		"secret", "put", name, "--name", worker)
	if err != nil {
		return fmt.Errorf("secrets: push %s/%s: %w", worker, name, err)
	}
	if r != nil && r.ExitCode != 0 {
		// RunWith already wraps non-zero into err, but be paranoid.
		return fmt.Errorf("secrets: push %s/%s: exit %d", worker, name, r.ExitCode)
	}
	return nil
}

// PushFunc adapts a function into a Pusher. Handy for tests that want
// to inline the stub instead of declaring a type.
type PushFunc func(ctx context.Context, svc, name, value string) error

// Push implements Pusher.
func (f PushFunc) Push(ctx context.Context, svc, name, value string) error {
	return f(ctx, svc, name, value)
}
