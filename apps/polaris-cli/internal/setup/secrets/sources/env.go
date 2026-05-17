package sources

import (
	"context"
	"os"
)

// EnvSource resolves a secret by looking it up in the process
// environment. If Overrides is non-nil it takes precedence over the
// real env — used by tests, and by the cmd leaf when it wants to feed
// .env.deploy through without polluting the actual environment.
type EnvSource struct {
	// Overrides maps secret name → value. nil means "no overrides, use
	// os.Getenv".
	Overrides map[string]string
}

// Name implements Source.
func (e *EnvSource) Name() string { return "env" }

// Load implements Source.
func (e *EnvSource) Load(_ context.Context, name string) (string, error) {
	if e != nil && e.Overrides != nil {
		if v, ok := e.Overrides[name]; ok && v != "" {
			return v, nil
		}
	}
	return os.Getenv(name), nil
}

// NewEnvSource is sugar for &EnvSource{Overrides: overrides}; callers
// that want pure os.Getenv lookup can pass nil.
func NewEnvSource(overrides map[string]string) *EnvSource {
	return &EnvSource{Overrides: overrides}
}
