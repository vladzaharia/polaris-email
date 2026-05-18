package secrets

import (
	"encoding/base64"
	"encoding/hex"
	"testing"
)

func TestGenerateMasterSecret_LenAndUnique(t *testing.T) {
	t.Parallel()
	a, err := GenerateMasterSecret()
	if err != nil {
		t.Fatalf("GenerateMasterSecret: %v", err)
	}
	b, err := GenerateMasterSecret()
	if err != nil {
		t.Fatalf("GenerateMasterSecret: %v", err)
	}
	if a == b {
		t.Fatalf("two calls returned identical secrets: %q", a)
	}
	dec, err := base64.RawStdEncoding.DecodeString(a)
	if err != nil {
		t.Fatalf("not valid base64: %v", err)
	}
	if len(dec) != 32 {
		t.Errorf("decoded length: want 32, got %d", len(dec))
	}
}

func TestGenerateArgon2Pepper_HexLen(t *testing.T) {
	t.Parallel()
	v, err := GenerateArgon2Pepper()
	if err != nil {
		t.Fatalf("GenerateArgon2Pepper: %v", err)
	}
	dec, err := hex.DecodeString(v)
	if err != nil {
		t.Fatalf("not valid hex: %v", err)
	}
	if len(dec) != 32 {
		t.Errorf("decoded length: want 32, got %d", len(dec))
	}
}

