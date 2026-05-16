package cmds

import (
	"os"
	"testing"
)

// TestMakeClientHonorsPolarisTokenEnv verifies the env-var fallback fires
// when neither flag nor config file supply a token. Regression for the prior
// ordering bug where the empty-check ran before the env read.
func TestMakeClientHonorsPolarisTokenEnv(t *testing.T) {
	saveAndRestore(t)
	t.Setenv("POLARIS_TOKEN", "env-secret-token")
	t.Setenv("POLARIS_API_URL", "https://env.example.test")
	t.Setenv("POLARIS_CONFIG", filepathJoin(t.TempDir(), "missing-config.toml"))
	G.Token = ""
	G.APIURL = ""

	c, err := MakeClient()
	if err != nil {
		t.Fatalf("MakeClient: %v", err)
	}
	if string(c.Secret) != "env-secret-token" {
		t.Fatalf("token = %q, want env-secret-token", string(c.Secret))
	}
	if c.BaseURL != "https://env.example.test" {
		t.Fatalf("baseURL = %q, want https://env.example.test", c.BaseURL)
	}
}

// CLI flag must beat the environment.
func TestMakeClientFlagBeatsEnv(t *testing.T) {
	saveAndRestore(t)
	t.Setenv("POLARIS_TOKEN", "env-secret-token")
	t.Setenv("POLARIS_API_URL", "https://env.example.test")
	t.Setenv("POLARIS_CONFIG", filepathJoin(t.TempDir(), "missing-config.toml"))
	G.Token = "flag-secret-token"
	G.APIURL = "https://flag.example.test"

	c, err := MakeClient()
	if err != nil {
		t.Fatalf("MakeClient: %v", err)
	}
	if string(c.Secret) != "flag-secret-token" {
		t.Fatalf("token = %q, want flag-secret-token", string(c.Secret))
	}
	if c.BaseURL != "https://flag.example.test" {
		t.Fatalf("baseURL = %q, want https://flag.example.test", c.BaseURL)
	}
}

// When the environment is empty AND no config is present, MakeClient must
// still surface a clear error rather than silently producing a zero-value
// client.
func TestMakeClientNoCredsErrors(t *testing.T) {
	saveAndRestore(t)
	t.Setenv("POLARIS_TOKEN", "")
	t.Setenv("POLARIS_API_URL", "")
	t.Setenv("POLARIS_CONFIG", filepathJoin(t.TempDir(), "missing-config.toml"))
	G.Token = ""
	G.APIURL = ""

	if _, err := MakeClient(); err == nil {
		t.Fatal("expected MakeClient to error with no creds")
	}
}

// saveAndRestore captures and restores the global flag-state + relevant env
// vars so individual tests don't leak into each other (cobra wires these as
// process-scoped globals).
func saveAndRestore(t *testing.T) {
	t.Helper()
	prevToken, prevURL, prevKey := G.Token, G.APIURL, G.KeyID
	prevConfig := G.ConfigPath
	prevProfile := G.Profile
	t.Cleanup(func() {
		G.Token = prevToken
		G.APIURL = prevURL
		G.KeyID = prevKey
		G.ConfigPath = prevConfig
		G.Profile = prevProfile
	})
	// Make sure no prior leak holds the env in a surprising state.
	for _, k := range []string{"POLARIS_TOKEN", "POLARIS_API_URL", "POLARIS_KEY_ID", "POLARIS_CONFIG"} {
		_ = os.Unsetenv(k)
	}
}

// Avoid pulling in path/filepath everywhere — keep a tiny join helper.
func filepathJoin(dir, base string) string {
	if dir == "" {
		return base
	}
	if dir[len(dir)-1] == os.PathSeparator {
		return dir + base
	}
	return dir + string(os.PathSeparator) + base
}
