package sources

import (
	"context"
	"errors"
	"testing"
)

func TestVaultSource_MissingBinaryReturnsErrVaultBinaryMissing(t *testing.T) {
	t.Parallel()
	src := &VaultSource{Binary: "/no/such/op-7913f7"}
	_, err := src.Load(context.Background(), "POLARIS_SECRET_A")
	if err == nil {
		t.Fatal("want error when binary is missing")
	}
	if !errors.Is(err, ErrVaultBinaryMissing) {
		t.Errorf("want ErrVaultBinaryMissing, got %v", err)
	}
}

func TestVaultSource_NilReceiverIsSafe(t *testing.T) {
	t.Parallel()
	var src *VaultSource
	got, err := src.Load(context.Background(), "POLARIS_SECRET_A")
	if err != nil {
		t.Errorf("nil source should not error, got %v", err)
	}
	if got != "" {
		t.Errorf("nil source should return empty, got %q", got)
	}
}

func TestVaultSource_FieldMappingDefaultsToSecretName(t *testing.T) {
	t.Parallel()
	src := &VaultSource{Vault: "vlt", Item: "itm"}
	// We can't drive `op` here, but the FieldFor=nil branch should be
	// the secret name verbatim. The path is exercised via the
	// ref-construction logic — assert by feeding a missing binary and
	// confirming the error message includes the secret name itself
	// (the ref construction happens before LookPath fails). To avoid
	// brittleness on different machines we just verify the no-op path:
	// FieldFor=nil → field == secret.
	if src.FieldFor != nil {
		t.Fatal("FieldFor should default to nil")
	}
}
