package cmds

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	polarissdk "github.com/polaris-email/polaris-sdk-go"
)

// withCapturedIO swaps Out/Errw with bytes.Buffers and restores them on
// cleanup; returns the two buffers for assertions.
func withCapturedIO(t *testing.T) (*bytes.Buffer, *bytes.Buffer) {
	t.Helper()
	prevOut, prevErr := Out, Errw
	out := &bytes.Buffer{}
	err := &bytes.Buffer{}
	Out = out
	Errw = err
	t.Cleanup(func() {
		Out = prevOut
		Errw = prevErr
	})
	return out, err
}

func TestAuthVerifyOK(t *testing.T) {
	out, errw := withCapturedIO(t)
	dir := t.TempDir()
	bodyFile := filepath.Join(dir, "body.json")
	body := []byte(`{"hello":"world"}`)
	if err := os.WriteFile(bodyFile, body, 0o600); err != nil {
		t.Fatal(err)
	}
	secret := "test-secret"
	ts := "1700000000000"
	nonce := "ABCDEFGHJKMNPQRSTVWXYZ01"
	sig, err := polarissdk.Sign(polarissdk.CanonicalInput{
		Direction: polarissdk.DirectionAPI,
		Method:    "POST",
		Path:      "/v1/messages",
		Query:     "",
		TS:        ts,
		Nonce:     nonce,
		Body:      body,
	}, []byte(secret))
	if err != nil {
		t.Fatal(err)
	}
	cmd := authVerifyCmd()
	cmd.SetArgs([]string{
		"--method", "POST",
		"--path", "/v1/messages",
		"--body", bodyFile,
		"--ts", ts,
		"--nonce", nonce,
		"--sig", sig,
		"--secret", secret,
	})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("execute: %v\nstdout=%q\nstderr=%q", err, out.String(), errw.String())
	}
	if !strings.Contains(out.String(), "OK") {
		t.Fatalf("expected OK on stdout, got %q", out.String())
	}
}

func TestAuthVerifyBadSig(t *testing.T) {
	out, errw := withCapturedIO(t)
	body := []byte(`{}`)
	dir := t.TempDir()
	bodyFile := filepath.Join(dir, "body.json")
	if err := os.WriteFile(bodyFile, body, 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := authVerifyCmd()
	// Use a 64-char hex string of zeros — wrong signature for any non-empty
	// secret. Verifier must reject and the cobra exit code must be non-zero.
	cmd.SetArgs([]string{
		"--method", "POST",
		"--path", "/v1/messages",
		"--body", bodyFile,
		"--ts", "1700000000000",
		"--nonce", "ABCDEFGHJKMNPQRSTVWXYZ01",
		"--sig", strings.Repeat("0", 64),
		"--secret", "secret",
	})
	cmd.SilenceUsage = true
	cmd.SilenceErrors = true
	err := cmd.Execute()
	if err == nil {
		t.Fatalf("expected error; stdout=%q stderr=%q", out.String(), errw.String())
	}
	if !errors.Is(err, errSignatureInvalid) {
		t.Fatalf("expected errSignatureInvalid, got %v", err)
	}
	if !strings.Contains(errw.String(), "INVALID") {
		t.Fatalf("expected INVALID on stderr, got %q", errw.String())
	}
}

func TestAuthVerifyMissingFlag(t *testing.T) {
	withCapturedIO(t)
	cmd := authVerifyCmd()
	cmd.SetArgs([]string{
		"--method", "POST",
		"--path", "/v1/messages",
		// Missing --ts/--nonce/--sig
		"--secret", "secret",
	})
	cmd.SilenceUsage = true
	cmd.SilenceErrors = true
	if err := cmd.Execute(); err == nil {
		t.Fatal("expected error for missing flags")
	}
}

func TestBridgeDeregisterRequiresConfirmName(t *testing.T) {
	withCapturedIO(t)
	// Skip the network call by attempting to construct the cmd and
	// ensuring the confirm-name guard fires before MakeClient. The cmd
	// flow is: MakeClient -> guard -> DoJSON. To isolate the guard we
	// install a token via env so MakeClient succeeds, but point at an
	// unroutable URL so the request would fail; the guard MUST fire
	// before any network attempt.
	saveAndRestore(t)
	t.Setenv("POLARIS_TOKEN", "tok")
	t.Setenv("POLARIS_API_URL", "http://127.0.0.1:1") // closed port
	t.Setenv("POLARIS_CONFIG", filepath.Join(t.TempDir(), "no-config.toml"))
	G.Token, G.APIURL = "", ""

	cmd := bridgeDeregisterCmd()
	cmd.SetArgs([]string{"my-bridge"}) // no --confirm-name
	cmd.SilenceUsage = true
	cmd.SilenceErrors = true
	err := cmd.Execute()
	if err == nil {
		t.Fatal("expected error when --confirm-name is missing")
	}
	if !strings.Contains(err.Error(), "--confirm-name") {
		t.Fatalf("expected --confirm-name in err, got %v", err)
	}
}

func TestBridgeDeregisterWrongConfirmName(t *testing.T) {
	withCapturedIO(t)
	saveAndRestore(t)
	t.Setenv("POLARIS_TOKEN", "tok")
	t.Setenv("POLARIS_API_URL", "http://127.0.0.1:1")
	t.Setenv("POLARIS_CONFIG", filepath.Join(t.TempDir(), "no-config.toml"))
	G.Token, G.APIURL = "", ""

	cmd := bridgeDeregisterCmd()
	cmd.SetArgs([]string{"my-bridge", "--confirm-name", "other-bridge"})
	cmd.SilenceUsage = true
	cmd.SilenceErrors = true
	err := cmd.Execute()
	if err == nil {
		t.Fatal("expected error when --confirm-name doesn't match")
	}
}
