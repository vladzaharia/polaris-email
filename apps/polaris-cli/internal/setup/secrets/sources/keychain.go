//go:build !keyring

package sources

import (
	"context"
	"errors"
)

// KeyringSource is the no-op stub used by default. The real
// implementation is gated on the `keyring` build tag and lives in
// keychain_keyring.go. We keep the symbol resolvable even without the
// tag so the runner's Source-list construction doesn't have to know
// about build tags.
type KeyringSource struct {
	// Service is the keychain "service" name; ignored by the stub.
	Service string
}

// ErrKeychainDisabled is returned by the no-op KeyringSource.Load. The
// runner treats this as "source has no opinion" rather than escalating.
var ErrKeychainDisabled = errors.New("sources: keychain disabled (build with -tags keyring)")

// Name implements Source.
func (k *KeyringSource) Name() string { return "keychain" }

// Load implements Source. The no-op variant always returns the disabled
// sentinel.
func (k *KeyringSource) Load(_ context.Context, _ string) (string, error) {
	return "", ErrKeychainDisabled
}
