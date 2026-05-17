package sources

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
)

// VaultSource resolves a secret by shelling out to the 1Password CLI:
//
//	op read op://<Vault>/<Item>/<field>
//
// Vault, Item, and a field-mapping function are configurable so the
// operator can point at their organisational structure. The defaults
// match `op://Engineering/polaris-email/<name>`.
//
// The op CLI is expected to be already signed-in (interactively or via
// `op signin --account ... --raw`); we do not attempt to drive a login
// flow here.
//
// VaultSource never logs the secret value. Errors include the op
// command line for debugging but suppress its stderr (which can include
// the secret in failure modes).
type VaultSource struct {
	// Vault is the 1Password vault name. Defaults to "Engineering" when empty.
	Vault string
	// Item is the item name inside the vault. Defaults to "polaris-email" when empty.
	Item string
	// FieldFor maps a secret name (POLARIS_SECRET_A) → field name on the
	// 1Password item. When nil the secret name is used verbatim.
	FieldFor func(secret string) string
	// Binary is the op CLI path. Defaults to "op" looked up in PATH.
	Binary string
}

// ErrVaultBinaryMissing is returned (and surfaced as a non-fatal warn by
// the runner) when the `op` binary isn't on PATH. We treat this as a
// "source has no opinion" condition rather than a hard failure so an
// operator who has env-only setups isn't forced to install 1Password.
var ErrVaultBinaryMissing = errors.New("sources: op (1Password CLI) binary not in PATH")

// Name implements Source.
func (v *VaultSource) Name() string { return "vault" }

// Load implements Source.
func (v *VaultSource) Load(ctx context.Context, name string) (string, error) {
	if v == nil {
		return "", nil
	}
	bin := v.Binary
	if bin == "" {
		bin = "op"
	}
	if _, err := exec.LookPath(bin); err != nil {
		return "", fmt.Errorf("%w: %v", ErrVaultBinaryMissing, err)
	}

	vault := v.Vault
	if vault == "" {
		vault = "Engineering"
	}
	item := v.Item
	if item == "" {
		item = "polaris-email"
	}
	field := name
	if v.FieldFor != nil {
		field = v.FieldFor(name)
	}
	ref := fmt.Sprintf("op://%s/%s/%s", vault, item, field)

	cmd := exec.CommandContext(ctx, bin, "read", ref)
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	// Discard stderr — `op` echoes the ref on failure which is fine,
	// but it can also surface fragments that might contain secret
	// material under odd error modes. The caller doesn't need the
	// stderr; the wrapped error is enough context.
	cmd.Stderr = &bytes.Buffer{}
	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			// Exit-code 1 from `op read` is "not found" — surface as
			// empty so the runner moves to the next source. Any other
			// code is escalated.
			if exitErr.ExitCode() == 1 {
				return "", nil
			}
		}
		return "", fmt.Errorf("sources/vault: op read %s: %w", ref, err)
	}
	return strings.TrimRight(stdout.String(), "\n"), nil
}
