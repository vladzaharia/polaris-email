// Package sources holds the pluggable secret loaders the seed runner
// consults. Each source resolves a (name) → value lookup; the runner
// tries every configured source in order and the first non-empty value
// wins.
//
// Three sources ship by default:
//
//   - EnvSource: reads from os.Getenv (and a fallback map for tests).
//   - VaultSource: shells out to `op read op://<vault>/<item>/<name>`.
//   - KeyringSource: opt-in via the `keyring` build tag, gated on the
//     github.com/zalando/go-keyring dependency.
//
// All sources must be cheap to construct and side-effect-free until
// Load is called — the runner instantiates all configured sources up
// front but only calls into them lazily, per-secret.
package sources

import "context"

// Source resolves a single named secret. An empty value + nil error
// means "this source has no opinion" — the runner moves on to the next
// source in the chain.
//
// Errors are best-effort: a Source that errors is logged but does not
// halt the chain. This matters because the vault source legitimately
// errors when the operator isn't signed in; we want the env-var
// fallback to still win.
type Source interface {
	// Name is a short identifier for logs / errors (e.g. "env",
	// "vault", "keychain").
	Name() string

	// Load looks up `secret` and returns its value. An empty string
	// (with nil error) means "not found in this source".
	Load(ctx context.Context, secret string) (string, error)
}
