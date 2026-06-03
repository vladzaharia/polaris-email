// Package config loads bridge configuration from environment variables.
//
// Convention: every env var carries the `BRIDGE_` prefix so a single
// container `env` block (or systemd `EnvironmentFile`) is unambiguous about
// what knobs the bridge consumes versus what's leaking in from the host.
//
// The prefix matches what `docker-compose.local.yml` and
// `docker-compose.tailscale.yml` set; both deployment modes are
// first-class, and both rely on these names.
//
// Var matrix (every var below has a Config field of the same intent):
//
//	BRIDGE_POLARIS_API_URL              required, base URL for polaris control-plane
//	BRIDGE_NAME                         required, EHLO/heartbeat identifier
//	BRIDGE_POLARIS_BRIDGE_ID /          one of these required (file form preferred for
//	BRIDGE_POLARIS_BRIDGE_ID_FILE       Docker-secrets / systemd-credential mounts)
//	BRIDGE_POLARIS_HMAC_KEY /           same — bridge HMAC key for control-plane auth
//	BRIDGE_POLARIS_HMAC_KEY_FILE
//	BRIDGE_TLS_CERT_DIR                 optional, default /var/lib/polaris-bridge/certs
//	                                    (bridge's embedded ACME loop owns this dir;
//	                                    writes fullchain.pem + privkey.pem here)
//	BRIDGE_SMTPS_LISTEN_ADDR            optional, default ":465"
//	BRIDGE_POLL_INTERVAL                optional, default 5s
//	BRIDGE_MAX_MESSAGE_SIZE             optional, default 50 MiB
//	BRIDGE_CREDSTORE_PATH               optional, default /var/lib/polaris-bridge/credstore.db
//	BRIDGE_LOGGING_FILE                 optional, default /var/log/polaris-bridge/audit.jsonl
//	BRIDGE_R2_BODY_MAX_BYTES            optional, default 64 MiB (IMAP body fetch cap)
//
// Removed in the embedded-ACME refactor (per the plan):
//   - BRIDGE_TLS_CERT_PATH / BRIDGE_TLS_KEY_PATH — paths derived from
//     TLSCertDir; the renewer owns the file layout.
//   - BRIDGE_ACCESS_CLIENT_ID / BRIDGE_ACCESS_CLIENT_SECRET — CF Access
//     is not in front of the polaris API; the bridge's HMAC is the
//     only auth surface (see project memory `no_cf_access`).
package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Config holds all runtime configuration.
type Config struct {
	APIURL     string
	BridgeName string
	BridgeID   string
	HMACKey    []byte

	// TLSCertDir is the directory the embedded ACME loop writes
	// fullchain.pem + privkey.pem into. internal/tls.Source loads from
	// here with a 30s hot-reload cadence.
	TLSCertDir string

	ListenAddr     string
	PollInterval   time.Duration
	MaxMessageSize int64
	SQLitePath     string
	AuditLogPath   string
	// R2BodyMaxBytes caps the size of an IMAP BODY[] fetch from R2. Defaults
	// to 64 MiB; matches the upstream R2 multipart upload ceiling.
	R2BodyMaxBytes int64
}

// TLSCertPath returns the path the renewer writes the fullchain to.
func (c *Config) TLSCertPath() string { return filepath.Join(c.TLSCertDir, "fullchain.pem") }

// TLSKeyPath returns the path the renewer writes the private key to.
func (c *Config) TLSKeyPath() string { return filepath.Join(c.TLSCertDir, "privkey.pem") }

// DefaultMaxMessageSizeBytes is the boot-time SMTP message cap used when
// BRIDGE_MAX_MESSAGE_SIZE is unset. It MUST equal the server's
// bridge_settings.max_message_size_bytes DEFAULT (migration
// 0013_bridge_settings_dual_listeners.sql). The heartbeat sends the
// server's authoritative value; the supervisor treats a message-size
// change as restart-required, but a restart re-seeds this same default —
// so if it disagrees with the server, the bridge exits and restarts on
// every heartbeat forever (no convergence). Keep the two in lockstep.
const DefaultMaxMessageSizeBytes int64 = 52428800 // 50 MiB

// Load reads the environment and returns a populated Config or an error
// listing every missing/invalid field.
func Load() (*Config, error) {
	var errs []string
	get := func(k string) string { return strings.TrimSpace(os.Getenv(k)) }

	apiURL := get("BRIDGE_POLARIS_API_URL")
	if apiURL == "" {
		errs = append(errs, "BRIDGE_POLARIS_API_URL required")
	}
	bridgeName := get("BRIDGE_NAME")
	if bridgeName == "" {
		errs = append(errs, "BRIDGE_NAME required")
	}

	bridgeID, err := readIDOrFile("BRIDGE_POLARIS_BRIDGE_ID", "BRIDGE_POLARIS_BRIDGE_ID_FILE")
	if err != nil {
		errs = append(errs, err.Error())
	}

	hmacKey, err := readKeyOrFile("BRIDGE_POLARIS_HMAC_KEY", "BRIDGE_POLARIS_HMAC_KEY_FILE")
	if err != nil {
		errs = append(errs, err.Error())
	}

	certDir := get("BRIDGE_TLS_CERT_DIR")
	if certDir == "" {
		certDir = "/var/lib/polaris-bridge/certs"
	}

	listen := get("BRIDGE_SMTPS_LISTEN_ADDR")
	if listen == "" {
		listen = ":465"
	}
	poll := 5 * time.Second
	if v := get("BRIDGE_POLL_INTERVAL"); v != "" {
		d, perr := time.ParseDuration(v)
		if perr != nil {
			errs = append(errs, "BRIDGE_POLL_INTERVAL invalid: "+perr.Error())
		} else {
			poll = d
		}
	}
	maxSize := DefaultMaxMessageSizeBytes
	if v := get("BRIDGE_MAX_MESSAGE_SIZE"); v != "" {
		n, perr := strconv.ParseInt(v, 10, 64)
		if perr != nil {
			errs = append(errs, "BRIDGE_MAX_MESSAGE_SIZE invalid: "+perr.Error())
		} else {
			maxSize = n
		}
	}
	sqlitePath := get("BRIDGE_CREDSTORE_PATH")
	if sqlitePath == "" {
		sqlitePath = "/var/lib/polaris-bridge/credstore.db"
	}
	auditPath := get("BRIDGE_LOGGING_FILE")
	if auditPath == "" {
		auditPath = "/var/log/polaris-bridge/audit.jsonl"
	}
	r2Cap := int64(64 << 20) // 64 MiB
	if v := get("BRIDGE_R2_BODY_MAX_BYTES"); v != "" {
		n, perr := strconv.ParseInt(v, 10, 64)
		if perr != nil {
			errs = append(errs, "BRIDGE_R2_BODY_MAX_BYTES invalid: "+perr.Error())
		} else if n <= 0 {
			errs = append(errs, "BRIDGE_R2_BODY_MAX_BYTES must be > 0")
		} else {
			r2Cap = n
		}
	}

	if len(errs) > 0 {
		return nil, fmt.Errorf("config errors: %s", strings.Join(errs, "; "))
	}

	return &Config{
		APIURL:         strings.TrimRight(apiURL, "/"),
		BridgeName:     bridgeName,
		BridgeID:       bridgeID,
		HMACKey:        hmacKey,
		TLSCertDir:     certDir,
		ListenAddr:     listen,
		PollInterval:   poll,
		MaxMessageSize: maxSize,
		SQLitePath:     sqlitePath,
		AuditLogPath:   auditPath,
		R2BodyMaxBytes: r2Cap,
	}, nil
}

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
