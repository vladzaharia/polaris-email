package mailtest_inproc

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	mt "github.com/vladzaharia/polaris-email/apps/mail-bridge/test/mailtest"
)

// sharedCA is minted once per package run; per-test server certs are
// issued from it. Cheap (ECDSA P-256) and lets every IMAPS / SMTPS
// client share one tls.Config root pool.
var sharedCA *mt.CA

// TestMain compiles the bridge binary once and stashes the path in
// BridgeBinary, then mints the package-wide CA. Both used by every
// inproc factory.
func TestMain(m *testing.M) {
	tmp, err := os.MkdirTemp("", "mailtest-inproc-")
	if err != nil {
		fmt.Fprintf(os.Stderr, "mailtest_inproc: mkdir: %v\n", err)
		os.Exit(1)
	}
	defer os.RemoveAll(tmp)

	bin := filepath.Join(tmp, "polaris-bridge")
	// Build with -race to match CI; the binary outlives any single test.
	build := exec.Command(
		"go", "build", "-race", "-o", bin,
		"github.com/vladzaharia/polaris-email/apps/mail-bridge/cmd/polaris-bridge",
	)
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "mailtest_inproc: build polaris-bridge: %v\n", err)
		os.Exit(1)
	}
	BridgeBinary = bin

	// Mint the package-wide CA via the standalone (error-returning) form.
	ca, err := mt.MintCAStandalone()
	if err != nil {
		fmt.Fprintf(os.Stderr, "mailtest_inproc: mint CA: %v\n", err)
		os.Exit(1)
	}
	sharedCA = ca

	os.Exit(m.Run())
}
