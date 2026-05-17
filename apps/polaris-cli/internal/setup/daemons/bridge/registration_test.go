package bridge

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestPersistRegistration_SetsPerms(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Skipf("chmod tempdir: %v", err)
	}
	in := &BridgeSetupInput{
		Mode:          ModeLocal,
		BridgeName:    "bridge-iad-1",
		Environment:   "prod",
		PolarisAPIURL: "https://api.polaris.example.com",
		PublicURL:     "https://mail.example.com",
		TLSSource:     TLSMounted,
		FQDN:          "mail.example.com",
		ImageTag:      "v1.0.0",
		Dir:           dir,
	}
	in.Defaults("v1.0.0")
	reg := &RegistrationData{
		BridgeID:           "00000000-0000-0000-0000-000000000001",
		HMACKeyID:          "kid_1",
		HMACSecret:         "shhh",
		AccessClientID:     "client-id",
		AccessClientSecret: "client-secret",
	}
	layout, err := PersistRegistration(dir, in, reg)
	if err != nil {
		t.Fatalf("persist: %v", err)
	}
	// All four secret files exist at 0600.
	for _, p := range []string{layout.BridgeIDPath, layout.HMACKeyPath, layout.AccessIDPath, layout.AccessSecretPath} {
		info, err := os.Stat(p)
		if err != nil {
			t.Fatalf("stat %s: %v", p, err)
		}
		if got := info.Mode().Perm(); got != 0o600 {
			t.Fatalf("%s mode = %#o want 0600", p, got)
		}
	}
	// secrets/ dir at 0700.
	info, _ := os.Stat(layout.Dir)
	if got := info.Mode().Perm(); got != 0o700 {
		t.Fatalf("secrets dir mode = %#o want 0700", got)
	}
	// registration.json at 0600.
	info, _ = os.Stat(layout.RegistrationPath)
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("registration.json mode = %#o want 0600", got)
	}
	// Snapshot has secret sentinels.
	snapBody, err := os.ReadFile(filepath.Join(dir, ".polaris-setup.json"))
	if err != nil {
		t.Fatalf("read snap: %v", err)
	}
	var snap map[string]any
	if err := json.Unmarshal(snapBody, &snap); err != nil {
		t.Fatalf("decode snap: %v", err)
	}
	if got := snap["hmac_secret"]; got != "file:secrets/hmac_key" {
		t.Fatalf("hmac sentinel = %v want file:secrets/hmac_key", got)
	}
	if got := snap["bridge_id"]; got != "file:secrets/bridge_id" {
		t.Fatalf("bridge_id sentinel = %v", got)
	}
}

func TestLoadRegistration_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	_ = os.Chmod(dir, 0o700)
	in := &BridgeSetupInput{
		Mode: ModeLocal, BridgeName: "bridge-1",
		Environment: "prod", PolarisAPIURL: "https://x", PublicURL: "https://y",
		TLSSource: TLSMounted, FQDN: "y", ImageTag: "v1", Dir: dir,
	}
	in.Defaults("v1")
	reg := &RegistrationData{
		BridgeID: "b1", HMACSecret: "s1", AccessClientID: "ci", AccessClientSecret: "cs",
	}
	if _, err := PersistRegistration(dir, in, reg); err != nil {
		t.Fatalf("persist: %v", err)
	}
	got, err := LoadRegistration(dir)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if got.BridgeID != reg.BridgeID || got.HMACSecret != reg.HMACSecret ||
		got.AccessClientID != reg.AccessClientID || got.AccessClientSecret != reg.AccessClientSecret {
		t.Fatalf("round-trip mismatch: %+v vs %+v", got, reg)
	}
}

func TestLoadRegistration_RemediatesMode(t *testing.T) {
	dir := t.TempDir()
	_ = os.Chmod(dir, 0o700)
	in := &BridgeSetupInput{
		Mode: ModeLocal, BridgeName: "bridge-1",
		Environment: "prod", PolarisAPIURL: "https://x", PublicURL: "https://y",
		TLSSource: TLSMounted, FQDN: "y", ImageTag: "v1", Dir: dir,
	}
	in.Defaults("v1")
	if _, err := PersistRegistration(dir, in, &RegistrationData{
		BridgeID: "b", HMACSecret: "s", AccessClientID: "i", AccessClientSecret: "c",
	}); err != nil {
		t.Fatalf("persist: %v", err)
	}
	// Operator (or rogue tooling) chmods to 0644.
	layout := NewSecretsLayout(dir)
	_ = os.Chmod(layout.HMACKeyPath, 0o644)
	if _, err := LoadRegistration(dir); err != nil {
		t.Fatalf("load: %v", err)
	}
	info, _ := os.Stat(layout.HMACKeyPath)
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("remediation failed: mode = %#o", got)
	}
}
