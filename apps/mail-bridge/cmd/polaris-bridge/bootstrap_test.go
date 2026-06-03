package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFileNonEmpty(t *testing.T) {
	dir := t.TempDir()

	empty := filepath.Join(dir, "empty")
	if err := os.WriteFile(empty, nil, 0o600); err != nil {
		t.Fatalf("write empty: %v", err)
	}
	nonEmpty := filepath.Join(dir, "key")
	if err := os.WriteFile(nonEmpty, []byte("tskey-abc123"), 0o600); err != nil {
		t.Fatalf("write nonEmpty: %v", err)
	}
	subdir := filepath.Join(dir, "adir")
	if err := os.Mkdir(subdir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	cases := []struct {
		name string
		path string
		want bool
	}{
		{"missing", filepath.Join(dir, "nope"), false},
		{"empty file", empty, false},
		{"non-empty file", nonEmpty, true},
		{"directory", subdir, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := fileNonEmpty(tc.path); got != tc.want {
				t.Errorf("fileNonEmpty(%s) = %v, want %v", tc.path, got, tc.want)
			}
		})
	}
}

// When the ts_authkey file is already present and non-empty, bootstrap
// must short-circuit BEFORE requiring any API env vars or calling the
// control plane. We prove the skip by pointing TS_AUTHKEY_PATH at a
// populated file while leaving BRIDGE_POLARIS_API_URL unset: if the
// early return didn't fire, runBootstrapTailscale would reach
// log.Fatalf (os.Exit) and kill this test process.
func TestRunBootstrapTailscaleSkipsWhenKeyPresent(t *testing.T) {
	dir := t.TempDir()
	keyPath := filepath.Join(dir, "ts_authkey")
	if err := os.WriteFile(keyPath, []byte("tskey-existing"), 0o600); err != nil {
		t.Fatalf("seed key: %v", err)
	}

	t.Setenv("TS_AUTHKEY_PATH", keyPath)
	t.Setenv("BRIDGE_POLARIS_API_URL", "")
	t.Setenv("BRIDGE_POLARIS_BRIDGE_ID", "")
	t.Setenv("BRIDGE_POLARIS_HMAC_KEY", "")

	// Returns cleanly (no os.Exit) ⇒ the idempotent skip fired.
	runBootstrapTailscale()

	// File must be untouched.
	got, err := os.ReadFile(keyPath)
	if err != nil {
		t.Fatalf("read key after run: %v", err)
	}
	if string(got) != "tskey-existing" {
		t.Errorf("ts_authkey was rewritten: got %q", string(got))
	}
}
