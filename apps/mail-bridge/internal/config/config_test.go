package config

import "testing"

// setRequiredEnv populates the env vars Load() treats as mandatory so a
// test can focus on the optional field under test.
func setRequiredEnv(t *testing.T) {
	t.Helper()
	t.Setenv("BRIDGE_POLARIS_API_URL", "https://api.example.com")
	t.Setenv("BRIDGE_NAME", "test-bridge")
	t.Setenv("BRIDGE_POLARIS_BRIDGE_ID", "01TESTBRIDGEID0000000000000")
	t.Setenv("BRIDGE_POLARIS_HMAC_KEY", "test-hmac-key")
}

// The boot default must match the server's bridge_settings default or the
// bridge restart-loops on every heartbeat (the supervisor flags a
// message-size change as restart-required, and a restart re-seeds the
// same default). 52428800 = 50 MiB = migration 0013 DEFAULT.
func TestLoadMaxMessageSizeDefaultMatchesServer(t *testing.T) {
	setRequiredEnv(t)
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.MaxMessageSize != 52428800 {
		t.Fatalf("default MaxMessageSize = %d, want 52428800 (must equal migration 0013 bridge_settings default)", cfg.MaxMessageSize)
	}
	if DefaultMaxMessageSizeBytes != 52428800 {
		t.Fatalf("DefaultMaxMessageSizeBytes = %d, want 52428800", DefaultMaxMessageSizeBytes)
	}
}

func TestLoadMaxMessageSizeEnvOverride(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("BRIDGE_MAX_MESSAGE_SIZE", "1048576")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.MaxMessageSize != 1048576 {
		t.Fatalf("MaxMessageSize = %d, want 1048576", cfg.MaxMessageSize)
	}
}
