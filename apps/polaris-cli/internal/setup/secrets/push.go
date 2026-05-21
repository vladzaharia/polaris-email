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

// WranglerPusher is the production Pusher. WorkerName resolves the
// service short-name (api, out, in, panel, ...) to the wrangler-side
// Worker name. When nil, the project's canonical `polaris-mail-<svc>`
// mapping is used — that matches every wrangler.jsonc's `name` field.
// Callers can override for tests or non-canonical deployments.
type WranglerPusher struct {
	WorkerName func(svc string) string
}

// Push implements Pusher.
func (p WranglerPusher) Push(ctx context.Context, svc, name, value string) error {
	worker := "polaris-mail-" + svc
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

// StorePusher is the account-level analogue of Pusher: pushes a single
// secret value to a Cloudflare Secrets Store once, regardless of how many
// Workers reference it via `secrets_store_secrets`.
type StorePusher interface {
	PushStore(ctx context.Context, name, value string) error
}

// WranglerSecretsStorePusher is the production StorePusher. It shells out
// to `wrangler secrets-store secret create` (or update, on conflict). The
// storeID identifies the account-level store and is supplied at config
// time (typically from POLARIS_SECRETS_STORE_ID in .env.deploy).
type WranglerSecretsStorePusher struct {
	StoreID string
}

// PushStore implements StorePusher.
func (p WranglerSecretsStorePusher) PushStore(ctx context.Context, name, value string) error {
	if p.StoreID == "" {
		return fmt.Errorf("secrets: store push %s: StoreID required", name)
	}
	if name == "" {
		return fmt.Errorf("secrets: store push: secret name required")
	}
	// `wrangler secrets-store secret create <STORE_ID> --name <NAME>`
	// reads the value from stdin. The `--remote` flag pins us to the
	// account-level store (not the local emulator).
	r, err := wrangler.RunWith(ctx, wrangler.Binary, strings.NewReader(value),
		"secrets-store", "secret", "create", p.StoreID,
		"--name", name, "--remote")
	if err == nil && r != nil && r.ExitCode == 0 {
		return nil
	}
	// Idempotent retry path: a `create` against an existing entry
	// returns non-zero. Fall through to `update`; if that also fails,
	// surface the original error.
	r2, err2 := wrangler.RunWith(ctx, wrangler.Binary, strings.NewReader(value),
		"secrets-store", "secret", "update", p.StoreID,
		"--name", name, "--remote")
	if err2 == nil && r2 != nil && r2.ExitCode == 0 {
		return nil
	}
	if err != nil {
		return fmt.Errorf("secrets: store push %s: %w", name, err)
	}
	return fmt.Errorf("secrets: store push %s: create+update both failed (exit %d, then %d)",
		name,
		safeExitCode(r),
		safeExitCode(r2),
	)
}

func safeExitCode(r *wrangler.Result) int {
	if r == nil {
		return -1
	}
	return r.ExitCode
}

// StorePushFunc adapts a function into a StorePusher.
type StorePushFunc func(ctx context.Context, name, value string) error

// PushStore implements StorePusher.
func (f StorePushFunc) PushStore(ctx context.Context, name, value string) error {
	return f(ctx, name, value)
}
