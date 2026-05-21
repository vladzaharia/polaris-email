//go:build !keyring

package sources

import (
	"context"
	"errors"
	"testing"
)

func TestKeyringSource_NoOpStubReturnsDisabled(t *testing.T) {
	t.Parallel()
	src := &KeyringSource{Service: "polaris-mail"}
	_, err := src.Load(context.Background(), "POLARIS_SECRET_A")
	if err == nil {
		t.Fatal("stub should return ErrKeychainDisabled")
	}
	if !errors.Is(err, ErrKeychainDisabled) {
		t.Errorf("want ErrKeychainDisabled, got %v", err)
	}
}
