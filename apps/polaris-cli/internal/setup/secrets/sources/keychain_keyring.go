//go:build keyring

package sources

import (
	"context"
	"errors"
	"fmt"

	"github.com/zalando/go-keyring"
)

// KeyringSource resolves a secret from the operator's OS keychain via
// zalando/go-keyring. The lookup is scoped to a "service" namespace —
// per platform conventions:
//
//   - macOS: keychain item under the "polaris-email" service.
//   - Linux: libsecret collection.
//   - Windows: Credential Manager.
//
// Build with `-tags keyring` to enable. The no-op stub in keychain.go is
// the default so a vanilla build doesn't require the libsecret system
// headers.
type KeyringSource struct {
	Service string
}

// Name implements Source.
func (k *KeyringSource) Name() string { return "keychain" }

// Load implements Source.
func (k *KeyringSource) Load(_ context.Context, name string) (string, error) {
	if k == nil {
		return "", nil
	}
	svc := k.Service
	if svc == "" {
		svc = "polaris-email"
	}
	v, err := keyring.Get(svc, name)
	if err != nil {
		if errors.Is(err, keyring.ErrNotFound) {
			return "", nil
		}
		return "", fmt.Errorf("sources/keychain: get %s/%s: %w", svc, name, err)
	}
	return v, nil
}
