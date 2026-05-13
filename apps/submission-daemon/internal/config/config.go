// Package config loads daemon configuration from environment variables.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config holds all runtime configuration.
type Config struct {
	APIURL             string
	DaemonName         string
	DaemonID           string
	HMACKey            []byte
	AccessClientID     string
	AccessClientSecret string
	TLSCert            string
	TLSKey             string

	ListenAddr     string
	PollInterval   time.Duration
	MaxMessageSize int64
	SQLitePath     string
	AuditLogPath   string
}

// Load reads the environment and returns a populated Config or an error
// listing every missing/invalid field.
func Load() (*Config, error) {
	var errs []string
	get := func(k string) string { return strings.TrimSpace(os.Getenv(k)) }

	apiURL := get("POLARIS_API_URL")
	if apiURL == "" {
		errs = append(errs, "POLARIS_API_URL required")
	}
	daemonName := get("DAEMON_NAME")
	if daemonName == "" {
		errs = append(errs, "DAEMON_NAME required")
	}

	daemonID, err := readIDOrFile("DAEMON_ID", "DAEMON_ID_FILE")
	if err != nil {
		errs = append(errs, err.Error())
	}

	hmacKey, err := readKeyOrFile("DAEMON_HMAC_KEY", "DAEMON_HMAC_KEY_FILE")
	if err != nil {
		errs = append(errs, err.Error())
	}

	accessID := get("ACCESS_CLIENT_ID")
	accessSecret := get("ACCESS_CLIENT_SECRET")
	if accessID == "" {
		errs = append(errs, "ACCESS_CLIENT_ID required")
	}
	if accessSecret == "" {
		errs = append(errs, "ACCESS_CLIENT_SECRET required")
	}
	tlsCert := get("TLS_CERT")
	tlsKey := get("TLS_KEY")
	if tlsCert == "" {
		errs = append(errs, "TLS_CERT required")
	}
	if tlsKey == "" {
		errs = append(errs, "TLS_KEY required")
	}

	listen := get("LISTEN_ADDR")
	if listen == "" {
		listen = ":465"
	}
	poll := 5 * time.Second
	if v := get("POLL_INTERVAL"); v != "" {
		d, perr := time.ParseDuration(v)
		if perr != nil {
			errs = append(errs, "POLL_INTERVAL invalid: "+perr.Error())
		} else {
			poll = d
		}
	}
	maxSize := int64(26214400)
	if v := get("MAX_MESSAGE_SIZE"); v != "" {
		n, perr := strconv.ParseInt(v, 10, 64)
		if perr != nil {
			errs = append(errs, "MAX_MESSAGE_SIZE invalid: "+perr.Error())
		} else {
			maxSize = n
		}
	}
	sqlitePath := get("SQLITE_PATH")
	if sqlitePath == "" {
		sqlitePath = "/var/lib/polaris-daemon/credstore.db"
	}
	auditPath := get("AUDIT_LOG_PATH")
	if auditPath == "" {
		auditPath = "/var/log/polaris-daemon/audit.log"
	}

	if len(errs) > 0 {
		return nil, fmt.Errorf("config errors: %s", strings.Join(errs, "; "))
	}

	return &Config{
		APIURL:             strings.TrimRight(apiURL, "/"),
		DaemonName:         daemonName,
		DaemonID:           daemonID,
		HMACKey:            hmacKey,
		AccessClientID:     accessID,
		AccessClientSecret: accessSecret,
		TLSCert:            tlsCert,
		TLSKey:             tlsKey,
		ListenAddr:         listen,
		PollInterval:       poll,
		MaxMessageSize:     maxSize,
		SQLitePath:         sqlitePath,
		AuditLogPath:       auditPath,
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
