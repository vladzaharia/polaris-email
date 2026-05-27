package mailtest

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// CA is a tiny in-test certificate authority used to mint server certs
// the bridge serves on its SMTPS/IMAPS listeners. Tests trust the CA via
// CABundle() so the test clients don't reject the self-signed cert.
type CA struct {
	Cert    *x509.Certificate
	Key     *ecdsa.PrivateKey
	CertPEM []byte
}

// MintCA returns a fresh CA valid for 2 hours. One CA per test (cheap
// thanks to ECDSA P-256).
func MintCA(t *testing.T) *CA {
	t.Helper()
	ca, err := MintCAStandalone()
	if err != nil {
		t.Fatalf("mailtest: %v", err)
	}
	return ca
}

// MintCAStandalone is the error-returning core; usable from TestMain
// (which doesn't have a *testing.T).
func MintCAStandalone() (*CA, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("ecdsa keygen: %w", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "polaris-test-ca"},
		NotBefore:             time.Now().Add(-1 * time.Minute),
		NotAfter:              time.Now().Add(2 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, fmt.Errorf("ca create: %w", err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, fmt.Errorf("ca parse: %w", err)
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	return &CA{Cert: cert, Key: key, CertPEM: pemBytes}, nil
}

// IssueServerCert mints a server cert with the given SANs (hostnames).
// Tests should pass at least one hostname matching what they'll dial.
func (ca *CA) IssueServerCert(t *testing.T, hosts ...string) tls.Certificate {
	t.Helper()
	if len(hosts) == 0 {
		hosts = []string{"smtps.test"}
	}
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("mailtest: leaf keygen: %v", err)
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		t.Fatalf("mailtest: serial: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: hosts[0]},
		NotBefore:    time.Now().Add(-1 * time.Minute),
		NotAfter:     time.Now().Add(2 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     hosts,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca.Cert, &leafKey.PublicKey, ca.Key)
	if err != nil {
		t.Fatalf("mailtest: leaf create: %v", err)
	}
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("mailtest: leaf parse: %v", err)
	}
	return tls.Certificate{
		Certificate: [][]byte{der, ca.Cert.Raw},
		PrivateKey:  leafKey,
		Leaf:        leaf,
	}
}

// WritePEMs dumps the cert + private key as fullchain.pem + privkey.pem
// in dir. The bridge's BRIDGE_TLS_CERT_DIR points here.
func WritePEMs(t *testing.T, dir string, cert tls.Certificate) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mailtest: mkdir certs: %v", err)
	}
	fullchain := filepath.Join(dir, "fullchain.pem")
	privkey := filepath.Join(dir, "privkey.pem")

	var chainPEM []byte
	for _, c := range cert.Certificate {
		chainPEM = append(chainPEM, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: c})...)
	}
	if err := os.WriteFile(fullchain, chainPEM, 0o644); err != nil {
		t.Fatalf("mailtest: write fullchain: %v", err)
	}

	key, ok := cert.PrivateKey.(*ecdsa.PrivateKey)
	if !ok {
		t.Fatalf("mailtest: cert key not ECDSA")
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatalf("mailtest: marshal key: %v", err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	if err := os.WriteFile(privkey, keyPEM, 0o600); err != nil {
		t.Fatalf("mailtest: write privkey: %v", err)
	}
}

// ClientTLSConfig returns a tls.Config that trusts the CA. ServerName
// defaults to "smtps.test" — pass an explicit override if your test
// dials a different SAN.
func (ca *CA) ClientTLSConfig(serverName string) *tls.Config {
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(ca.CertPEM)
	if serverName == "" {
		serverName = "smtps.test"
	}
	return &tls.Config{
		RootCAs:    pool,
		ServerName: serverName,
		MinVersion: tls.VersionTLS12,
	}
}
