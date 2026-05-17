package sources

import (
	"context"
	"testing"
)

func TestEnvSource_Overrides(t *testing.T) {
	t.Parallel()
	src := NewEnvSource(map[string]string{
		"POLARIS_SECRET_A": "from-override",
	})
	got, err := src.Load(context.Background(), "POLARIS_SECRET_A")
	if err != nil {
		t.Fatal(err)
	}
	if got != "from-override" {
		t.Errorf("want from-override, got %q", got)
	}
}

func TestEnvSource_FallsBackToOSEnv(t *testing.T) {
	t.Setenv("POLARIS_TEST_KEY_XYZZY", "from-os")
	src := NewEnvSource(nil)
	got, err := src.Load(context.Background(), "POLARIS_TEST_KEY_XYZZY")
	if err != nil {
		t.Fatal(err)
	}
	if got != "from-os" {
		t.Errorf("want from-os, got %q", got)
	}
}

func TestEnvSource_EmptyReturnsEmpty(t *testing.T) {
	t.Parallel()
	src := NewEnvSource(map[string]string{})
	got, err := src.Load(context.Background(), "NOPE_DOES_NOT_EXIST_7913f7")
	if err != nil {
		t.Fatal(err)
	}
	if got != "" {
		t.Errorf("want empty, got %q", got)
	}
}

func TestEnvSource_NilReceiverIsSafe(t *testing.T) {
	t.Parallel()
	var src *EnvSource
	// nil receiver with overrides=nil works because Load reads from
	// os.Getenv. Defensive coverage so the runner can pass nil entries
	// without panicking.
	got, _ := src.Load(context.Background(), "NEVER_SET_XYZZY")
	if got != "" {
		t.Errorf("nil source should return empty, got %q", got)
	}
}
