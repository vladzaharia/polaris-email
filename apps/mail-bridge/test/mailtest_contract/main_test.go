//go:build mailtest_contract

package mailtest_contract

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	mt "github.com/vladzaharia/polaris-email/apps/mail-bridge/test/mailtest"
)

var (
	wranglerCleanup func()
	// Bridge binary path — built once per package.
	bridgeBinary string
	// Admin credentials from /v1/admin/bootstrap.
	adminKeyID     string
	adminKeySecret string
	// Path of the .dev.vars we wrote so TestMain can delete it on exit.
	devVarsPath string
	// RepoRoot is the absolute repo root.
	repoRoot string
)

func TestMain(m *testing.M) {
	root, err := findRepoRoot()
	if err != nil {
		fmt.Fprintf(os.Stderr, "mailtest_contract: find repo root: %v\n", err)
		os.Exit(1)
	}
	repoRoot = root

	// 1. Generate POLARIS_SECRET_A and write to .dev.vars so wrangler dev
	//    picks it up (the bootstrap endpoint refuses without it).
	secretA := randomHex(32)
	devVarsPath, err = WriteDevVars(repoRoot, secretA)
	if err != nil {
		fmt.Fprintf(os.Stderr, "mailtest_contract: write .dev.vars: %v\n", err)
		os.Exit(1)
	}
	defer func() { _ = os.Remove(devVarsPath) }()

	// 2. Build the bridge binary once per package.
	tmp, err := os.MkdirTemp("", "mailtest-contract-")
	if err != nil {
		fmt.Fprintf(os.Stderr, "mailtest_contract: mkdir: %v\n", err)
		os.Exit(1)
	}
	defer os.RemoveAll(tmp)
	bridgeBinary = filepath.Join(tmp, "polaris-bridge")
	build := exec.Command(
		"go", "build", "-o", bridgeBinary,
		"github.com/vladzaharia/polaris-email/apps/mail-bridge/cmd/polaris-bridge",
	)
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "mailtest_contract: build bridge: %v\n", err)
		os.Exit(1)
	}

	// 3. Boot wrangler dev.
	ports := mt.AllocatePortsStandalone(1)
	if len(ports) == 0 {
		fmt.Fprintf(os.Stderr, "mailtest_contract: allocate port failed\n")
		os.Exit(1)
	}
	url, cleanup, err := StartWrangler(context.Background(), ports[0], repoRoot)
	if err != nil {
		fmt.Fprintf(os.Stderr, "mailtest_contract: start wrangler: %v\n", err)
		os.Exit(1)
	}
	WranglerBaseURL = url
	wranglerCleanup = cleanup

	// 4. Bootstrap an admin operator. Idempotent across TestMain runs
	//    within the same wrangler lifetime via the Idempotency-Key.
	boot, err := BootstrapAdminKey(context.Background(), url, secretA, "mailtest-contract-boot")
	if err != nil {
		fmt.Fprintf(os.Stderr, "mailtest_contract: bootstrap: %v\n", err)
		cleanup()
		os.Exit(1)
	}
	adminKeyID = boot.AdminKeyID
	adminKeySecret = boot.AdminKeySecret

	code := m.Run()
	cleanup()
	os.Exit(code)
}

func findRepoRoot() (string, error) {
	wd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for d := wd; d != "/" && d != "."; d = filepath.Dir(d) {
		if _, err := os.Stat(filepath.Join(d, "pnpm-workspace.yaml")); err == nil {
			return d, nil
		}
	}
	return "", fmt.Errorf("pnpm-workspace.yaml not found above %s", wd)
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Sprintf("mailtest_contract: rand: %v", err))
	}
	return hex.EncodeToString(b)
}
