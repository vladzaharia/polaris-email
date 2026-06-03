package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	polarissdk "github.com/polaris-mail/polaris-sdk-go"
)

// Bridge-config disk cache.
//
// /v1/bridge/config carries the operational keys the bridge needs at
// boot — the per-bridge CF DNS-01 token, the FQDN, the ACME email, the
// tailnet FQDN. The server keeps the CF token plaintext only in a KV
// cache, so the endpoint can return `key_propagating` (or just be
// unreachable) when KV has expired or the network blips. That used to be
// fatal (main.go log.Fatalf), which is exactly how the reported boot
// failure manifested.
//
// We cache the last-good response so a transient fetch failure falls back
// to it instead of taking the bridge down. The file holds a secret (the
// CF token), so it's written 0600 on the bridge-data volume — the same
// trust boundary as ./secrets/hmac_key, which the host already holds.

// saveBridgeConfig atomically persists the last-good config (0600 — it
// contains the CF DNS token).
func saveBridgeConfig(path string, cfg *polarissdk.BridgeConfig) error {
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("encode bridge config: %w", err)
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", dir, err)
	}
	tmp, err := os.CreateTemp(dir, filepath.Base(path)+".tmp-*")
	if err != nil {
		return fmt.Errorf("create temp in %s: %w", dir, err)
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	if _, err := tmp.Write(b); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write temp: %w", err)
	}
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("chmod temp: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("rename %s → %s: %w", tmpName, path, err)
	}
	return nil
}

// loadBridgeConfig reads the cached config. A missing file is an error
// (the caller only reaches here after a fetch failure, so "no cache
// either" is genuinely unrecoverable and should stay fatal).
func loadBridgeConfig(path string) (*polarissdk.BridgeConfig, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read cached bridge config %s: %w", path, err)
	}
	var cfg polarissdk.BridgeConfig
	if err := json.Unmarshal(b, &cfg); err != nil {
		return nil, fmt.Errorf("decode cached bridge config %s: %w", path, err)
	}
	return &cfg, nil
}
