// Bootstrap subcommands — short-lived helpers invoked by the
// docker-compose init container pattern.
//
// `polaris-bridge bootstrap-tailscale`:
//   - Idempotent: if the ts_authkey file already exists on the
//     persistent volume, it skips the API call and exits 0. This lets a
//     second `compose up` succeed without re-hitting /v1/bridge/config.
//   - Loads the minimum config needed to authenticate against the
//     polaris API: bridge id + HMAC key (via `*_FILE` indirection from
//     the docker secrets mount) + BRIDGE_POLARIS_API_URL.
//   - Calls GET /v1/bridge/config; reads `ts_authkey` from the
//     response.
//   - If non-empty: writes it to `${TS_AUTHKEY_PATH:-/run/secrets/ts_authkey}`
//     with mode 0600, then exits 0. The Tailscale sidecar's
//     `TS_AUTHKEY_FILE` env points at the same path.
//   - If empty: logs a warning and exits 0 anyway, so docker-compose's
//     `service_completed_successfully` gate still passes. The
//     operator's TS sidecar will fall back to whatever state already
//     exists on its volume (typically: prior tailnet session
//     re-attaches without needing a fresh key).
//
// The whole subcommand is dependency-light on purpose: no SQLite, no
// listener wiring. It reads env, makes one HTTPS call, writes one
// file. Fast enough that docker compose's startup wait is invisible.

package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	polarissdk "github.com/polaris-mail/polaris-sdk-go"
)

const (
	defaultTSAuthkeyPath = "/run/secrets/ts_authkey"
	bootstrapTimeout     = 30 * time.Second
)

func runBootstrapTailscale() {
	outPath := strings.TrimSpace(os.Getenv("TS_AUTHKEY_PATH"))
	if outPath == "" {
		outPath = defaultTSAuthkeyPath
	}

	// Idempotency: the bootstrap container reruns on every `compose up`,
	// but the ts_authkey lives on the persistent `bridge-runtime` volume.
	// If it's already there, skip the API call entirely — re-fetching
	// would trip `key_propagating` once the install URL's plaintext cache
	// window has closed, failing the second `up` for no reason. Exit 0 so
	// the compose `service_completed_successfully` gate still passes. (To
	// force a refetch after a roll, the operator clears the volume; TS
	// auth keys are join-time only, so `ts-state` keeps the node attached.)
	if fileNonEmpty(outPath) {
		log.Printf("bootstrap-tailscale: ts_authkey already present at %s; skipping re-download", outPath)
		return
	}

	apiURL := strings.TrimRight(strings.TrimSpace(os.Getenv("BRIDGE_POLARIS_API_URL")), "/")
	if apiURL == "" {
		log.Fatalf("bootstrap-tailscale: BRIDGE_POLARIS_API_URL required")
	}
	bridgeID, err := readIDOrFile("BRIDGE_POLARIS_BRIDGE_ID", "BRIDGE_POLARIS_BRIDGE_ID_FILE")
	if err != nil {
		log.Fatalf("bootstrap-tailscale: %v", err)
	}
	hmacKey, err := readKeyOrFile("BRIDGE_POLARIS_HMAC_KEY", "BRIDGE_POLARIS_HMAC_KEY_FILE")
	if err != nil {
		log.Fatalf("bootstrap-tailscale: %v", err)
	}

	sdk := polarissdk.NewClient(apiURL)
	sdk.BridgeID = bridgeID
	sdk.BridgeSecret = hmacKey

	ctx, cancel := context.WithTimeout(context.Background(), bootstrapTimeout)
	defer cancel()

	cfg, err := sdk.GetBridgeConfig(ctx)
	if err != nil {
		log.Fatalf("bootstrap-tailscale: fetch config: %v", err)
	}
	if cfg.TsAuthkey == "" {
		log.Printf("bootstrap-tailscale: server returned no ts_authkey (TS minting not configured); skipping file write")
		return
	}

	// Atomic write so the TS sidecar never reads a half-written file.
	if err := writeFileAtomic(outPath, []byte(cfg.TsAuthkey), 0o600); err != nil {
		log.Fatalf("bootstrap-tailscale: write %s: %v", outPath, err)
	}
	log.Printf("bootstrap-tailscale: wrote ts_authkey to %s (%d bytes)", outPath, len(cfg.TsAuthkey))
}

// Two helpers duplicate the shape of internal/config's readers but
// stay local so bootstrap doesn't pull in the full config-loader for
// just two env vars. Trivial to converge later if config.go grows a
// public read helper.

func readIDOrFile(direct, fileVar string) (string, error) {
	if v := strings.TrimSpace(os.Getenv(direct)); v != "" {
		return v, nil
	}
	if path := strings.TrimSpace(os.Getenv(fileVar)); path != "" {
		b, err := os.ReadFile(path)
		if err != nil {
			return "", fmt.Errorf("read %s=%s: %w", fileVar, path, err)
		}
		return strings.TrimSpace(string(b)), nil
	}
	return "", fmt.Errorf("either %s or %s required", direct, fileVar)
}

func readKeyOrFile(direct, fileVar string) ([]byte, error) {
	if v := strings.TrimSpace(os.Getenv(direct)); v != "" {
		return []byte(v), nil
	}
	if path := strings.TrimSpace(os.Getenv(fileVar)); path != "" {
		b, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read %s=%s: %w", fileVar, path, err)
		}
		return []byte(strings.TrimSpace(string(b))), nil
	}
	return nil, fmt.Errorf("either %s or %s required", direct, fileVar)
}

// fileNonEmpty reports whether path exists, is a regular file, and has
// non-zero size. Used to make bootstrap idempotent across compose reruns.
func fileNonEmpty(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Size() > 0
}

func writeFileAtomic(dst string, data []byte, mode os.FileMode) error {
	tmp := dst + ".new"
	if err := os.WriteFile(tmp, data, mode); err != nil {
		return err
	}
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// Silence "declared but unused" for the errors import in case future
// expansion drops it. Keeps the file's import set deterministic.
var _ = errors.New
