package tls

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeSelfSigned(t *testing.T, dir string) (cert, key string) {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "bridge.test"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &priv.PublicKey, priv)
	if err != nil {
		t.Fatal(err)
	}
	cert = filepath.Join(dir, "cert.pem")
	key = filepath.Join(dir, "key.pem")
	if err := os.WriteFile(cert, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	kb, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(key, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kb}), 0o600); err != nil {
		t.Fatal(err)
	}
	return
}

func TestLocalModeLoadsCert(t *testing.T) {
	dir := t.TempDir()
	cert, key := writeSelfSigned(t, dir)
	s, err := New(Config{Mode: ModeLocal, CertPath: cert, KeyPath: key})
	if err != nil {
		t.Fatal(err)
	}
	c, err := s.GetCertificate(nil)
	if err != nil {
		t.Fatal(err)
	}
	if c == nil || len(c.Certificate) == 0 {
		t.Fatal("expected non-empty cert")
	}
}

func TestTailscaleModeStubError(t *testing.T) {
	_, err := New(Config{Mode: ModeTailscale, TailscaleHostname: "x"})
	if err == nil {
		t.Fatal("expected tsnet mode to error in this slice")
	}
	// Phase 2d bug #4: callers must be able to identify the unsupported
	// mode via errors.Is so main.go can fail-fast (preventing the silent
	// degrade-to-plaintext path on :993).
	if !errors.Is(err, ErrTailscaleUnsupported) {
		t.Fatalf("err = %v, want errors.Is(ErrTailscaleUnsupported)", err)
	}
}

func TestLocalModeMissingPaths(t *testing.T) {
	if _, err := New(Config{Mode: ModeLocal}); err == nil {
		t.Fatal("expected error on missing paths")
	}
}
