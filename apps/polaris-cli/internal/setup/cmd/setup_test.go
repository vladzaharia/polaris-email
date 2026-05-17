package cmd

import (
	"testing"

	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup"
)

// findSubcommand walks one level under root and returns the child whose
// Use name matches `name`, or nil.
func findSubcommand(root *cobra.Command, name string) *cobra.Command {
	for _, c := range root.Commands() {
		if c.Name() == name {
			return c
		}
	}
	return nil
}

// TestNewSetupCmd_GeneratesBridgeSubtree verifies that the blank-import
// of internal/setup/daemons/bridge in setup.go registers the bridge
// descriptor and that the cobra generator emits every expected leaf
// under `setup bridge`.
func TestNewSetupCmd_GeneratesBridgeSubtree(t *testing.T) {
	if _, ok := setup.Get("bridge"); !ok {
		t.Fatal("expected bridge daemon to be registered via blank import")
	}

	root := NewSetupCmd(Options{CLIVersion: "v0.0.0-test"})
	bridge := findSubcommand(root, "bridge")
	if bridge == nil {
		t.Fatal("setup tree missing the `bridge` subcommand")
	}

	wantLeaves := []string{
		"precheck", "init", "register", "up", "verify",
		"status", "down", "destroy", "upgrade",
	}
	for _, leaf := range wantLeaves {
		if findSubcommand(bridge, leaf) == nil {
			t.Errorf("setup bridge %s leaf is missing", leaf)
		}
	}
}

// TestNewSetupCmd_BridgeHelpHasMode verifies that the descriptor's
// Long() string reaches the cobra command and mentions both deployment
// modes — the user's directive that both modes are first-class is
// load-bearing.
func TestNewSetupCmd_BridgeHelpHasMode(t *testing.T) {
	root := NewSetupCmd(Options{CLIVersion: "v0.0.0-test"})
	bridge := findSubcommand(root, "bridge")
	if bridge == nil {
		t.Fatal("setup bridge missing")
	}
	if bridge.Long == "" {
		t.Fatal("bridge.Long is empty")
	}
	for _, want := range []string{"local", "tailscale", "first-class"} {
		if !contains(bridge.Long, want) {
			t.Errorf("bridge.Long is missing %q\n%s", want, bridge.Long)
		}
	}
}

// TestNewSetupCmd_BridgeCommonFlags verifies that the generator wires
// the shared --dir / --from-file / --image-tag / --profile flag set.
func TestNewSetupCmd_BridgeCommonFlags(t *testing.T) {
	root := NewSetupCmd(Options{CLIVersion: "v0.0.0-test"})
	bridge := findSubcommand(root, "bridge")
	if bridge == nil {
		t.Fatal("setup bridge missing")
	}
	want := []string{"dir", "from-file", "non-interactive", "yes", "image-tag", "profile"}
	for _, name := range want {
		if bridge.Flags().Lookup(name) == nil {
			t.Errorf("bare `setup bridge` missing --%s flag", name)
		}
	}
	// Spot-check that the precheck leaf inherits the same shared flags.
	pre := findSubcommand(bridge, "precheck")
	if pre == nil {
		t.Fatal("precheck leaf missing")
	}
	for _, name := range want {
		if pre.Flags().Lookup(name) == nil {
			t.Errorf("setup bridge precheck missing --%s flag", name)
		}
	}
}

// TestNewSetupCmd_DownHasVolumesFlag verifies the leaf-specific extras
// land on the right subcommand.
func TestNewSetupCmd_DownHasVolumesFlag(t *testing.T) {
	root := NewSetupCmd(Options{CLIVersion: "v0.0.0-test"})
	bridge := findSubcommand(root, "bridge")
	down := findSubcommand(bridge, "down")
	if down == nil {
		t.Fatal("setup bridge down missing")
	}
	if down.Flags().Lookup("volumes") == nil {
		t.Error("setup bridge down missing --volumes flag")
	}
}

// TestNewSetupCmd_InfraStillWired verifies the explicitly-wired infra
// subtree was not lost in the generator refactor.
func TestNewSetupCmd_InfraStillWired(t *testing.T) {
	root := NewSetupCmd(Options{CLIVersion: "v0.0.0-test"})
	if findSubcommand(root, "infra") == nil {
		t.Fatal("setup infra subtree was lost in the daemon-registry refactor")
	}
}

func contains(s, substr string) bool {
	for i := 0; i+len(substr) <= len(s); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
