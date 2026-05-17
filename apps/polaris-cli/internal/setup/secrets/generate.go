// Package secrets handles the phase-5 work of bin/bootstrap.sh:
// generating master secrets, pushing them at every Worker via
// `wrangler secret put`, and recording a sha256-only audit row in
// secrets.created.json.
//
// Design constraints:
//
//   - Master secret values are never written to disk by this package.
//     The plain bytes flow through an in-memory map, get piped into the
//     wrangler stdin, and are dropped on return. The audit record carries
//     only sha256(value) so an operator can diff later.
//
//   - The phase is idempotent. Each secret has a (name, service) tuple;
//     once a sha256 row exists for that pair the runner skips it.
//
//   - Source loaders are pluggable. The default chain is env →
//     1Password vault (op CLI) → opt-in OS keychain. The runner
//     tries each source in order; the first non-empty value wins.
//
//   - Failure isolation: when one secret push fails we keep going for
//     the rest (so a transient wrangler hiccup on the 9th of 12 doesn't
//     waste the prior eight) but the runner returns a descriptive
//     error citing exactly which (name, service) pairs landed.
package secrets

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
)

// GenerateMasterSecret returns a 32-byte cryptographically-random secret
// encoded as unpadded standard base64. Matches the historical shape that
// `openssl rand -base64 32 | tr -d '\n='` produced, so any operator
// rotating from the shell path lands on the same length.
func GenerateMasterSecret() (string, error) {
	b, err := randomBytes(32)
	if err != nil {
		return "", err
	}
	return base64.RawStdEncoding.EncodeToString(b), nil
}

// GenerateArgon2Pepper returns a 32-byte cryptographically-random pepper
// encoded as lowercase hex. Argon2 peppers are typically encoded as hex
// in our schema (mirrors the password-hashing tests in services/api)
// so the verifier reads bytes without an extra decode step.
func GenerateArgon2Pepper() (string, error) {
	b, err := randomBytes(32)
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// GenerateAnchorSigningKey returns a 32-byte cryptographically-random
// signing key encoded as unpadded standard base64. Anchor signing uses
// the same shape as POLARIS_SECRET_A — the only reason for a separate
// generator is to keep callers honest about the semantic distinction.
func GenerateAnchorSigningKey() (string, error) {
	return GenerateMasterSecret()
}

// randomBytes reads n bytes from crypto/rand and surfaces a sensible
// error if the source ever short-reads (it does not on a healthy system,
// but the standard error message is opaque enough that wrapping helps).
func randomBytes(n int) ([]byte, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return nil, fmt.Errorf("secrets: crypto/rand: %w", err)
	}
	return b, nil
}
