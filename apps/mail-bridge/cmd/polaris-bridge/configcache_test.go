package main

import (
	"os"
	"path/filepath"
	"testing"

	polarissdk "github.com/polaris-mail/polaris-sdk-go"
)

func TestBridgeConfigCacheRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	want := &polarissdk.BridgeConfig{
		CFDnsToken:  "cf-token-secret",
		CFZone:      "mail.plrs.im",
		FQDN:        "greenwood.mail.plrs.im",
		TailnetFQDN: "greenwood-mail.tail1234.ts.net",
		AcmeEmail:   "ops@example.com",
		TsAuthkey:   "tskey-auth-xxx",
	}
	if err := saveBridgeConfig(path, want); err != nil {
		t.Fatalf("saveBridgeConfig: %v", err)
	}
	got, err := loadBridgeConfig(path)
	if err != nil {
		t.Fatalf("loadBridgeConfig: %v", err)
	}
	if *got != *want {
		t.Fatalf("round-trip mismatch:\n got %+v\nwant %+v", *got, *want)
	}
}

// The cache holds a CF token, so it must be 0600.
func TestBridgeConfigCacheIs0600(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := saveBridgeConfig(path, &polarissdk.BridgeConfig{FQDN: "x"}); err != nil {
		t.Fatalf("saveBridgeConfig: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("perm = %o, want 600", perm)
	}
}

func TestLoadBridgeConfigMissingIsError(t *testing.T) {
	if _, err := loadBridgeConfig(filepath.Join(t.TempDir(), "absent.json")); err == nil {
		t.Fatal("expected error loading a missing cache file, got nil")
	}
}
