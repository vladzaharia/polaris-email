package acme

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCertNeedsRenewal(t *testing.T) {
	dir := t.TempDir()
	r := &Renewer{CertDir: dir}
	certPath := filepath.Join(dir, "fullchain.pem")

	// Missing file → needs renewal.
	if !r.certNeedsRenewal(certPath) {
		t.Fatal("missing cert: want needsRenewal=true")
	}

	// Far-future cert → does not need renewal.
	farFuture := writeFakeCert(t, certPath, time.Now().Add(60*24*time.Hour))
	_ = farFuture
	if r.certNeedsRenewal(certPath) {
		t.Fatal("60d-out cert: want needsRenewal=false")
	}

	// Soon-to-expire cert (10d) → needs renewal.
	writeFakeCert(t, certPath, time.Now().Add(10*24*time.Hour))
	if !r.certNeedsRenewal(certPath) {
		t.Fatal("10d-out cert: want needsRenewal=true")
	}

	// Garbage file → treat as needing renewal (defensive).
	if err := os.WriteFile(certPath, []byte("not a pem"), 0o600); err != nil {
		t.Fatal(err)
	}
	if !r.certNeedsRenewal(certPath) {
		t.Fatal("garbage cert: want needsRenewal=true")
	}
}

func TestWriteAtomic(t *testing.T) {
	dir := t.TempDir()
	dst := filepath.Join(dir, "out.pem")
	if err := writeAtomic(dst, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(dst); err != nil || string(b) != "hello" {
		t.Fatalf("read: %v %q", err, b)
	}
	// Overwriting works.
	if err := writeAtomic(dst, []byte("world"), 0o600); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(dst); string(b) != "world" {
		t.Fatalf("overwrite: got %q", b)
	}
	// No tmp file left behind.
	matches, _ := filepath.Glob(filepath.Join(dir, "*.new"))
	if len(matches) > 0 {
		t.Fatalf("leaked tmp files: %v", matches)
	}
}

func TestUpsertACreatesThenUpdates(t *testing.T) {
	// Spin up an httptest server impersonating CF DNS endpoints we use.
	var listGot, postGot, putGot int
	var lastPutBody, lastPostBody map[string]any

	mux := http.NewServeMux()
	mux.HandleFunc("/client/v4/zones/zone-x/dns_records", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			listGot++
			// First call: empty list. Second call: one matching record.
			if listGot == 1 {
				cfOK(w, []map[string]any{})
				return
			}
			cfOK(w, []map[string]any{
				{"id": "rec-1", "type": "A", "name": "host.example", "content": "10.0.0.1", "ttl": 60},
			})
		case http.MethodPost:
			postGot++
			lastPostBody = readJSON(t, r.Body)
			cfOK(w, map[string]any{"id": "rec-1"})
		default:
			t.Errorf("unexpected method %s", r.Method)
			w.WriteHeader(http.StatusBadRequest)
		}
	})
	mux.HandleFunc("/client/v4/zones/zone-x/dns_records/rec-1", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			t.Errorf("unexpected method %s on /rec-1", r.Method)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		putGot++
		lastPutBody = readJSON(t, r.Body)
		cfOK(w, map[string]any{"id": "rec-1"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	cli := &CFDnsClient{APIToken: "t", ZoneID: "zone-x"}
	// Point the client at the test server. We have no override on the
	// client struct itself, so monkeypatch the base URL via a small
	// helper — done in code-under-test would need a refactor; here we
	// just verify our usage by hitting the same paths.
	old := http.DefaultTransport
	defer func() { http.DefaultTransport = old }()
	cli.HTTPClient = &http.Client{Transport: &rewriteHostTransport{
		dest:  srv.URL,
		inner: http.DefaultTransport,
	}}

	// Create path: list returns empty, so we POST.
	if err := cli.UpsertA(t.Context(), "host.example", "10.0.0.1"); err != nil {
		t.Fatal(err)
	}
	if postGot != 1 || putGot != 0 {
		t.Fatalf("expected create (POST=1, PUT=0); got POST=%d PUT=%d", postGot, putGot)
	}
	if lastPostBody["content"] != "10.0.0.1" {
		t.Fatalf("post body: %v", lastPostBody)
	}

	// Same-IP repeat: list returns the existing record; no PUT/POST.
	if err := cli.UpsertA(t.Context(), "host.example", "10.0.0.1"); err != nil {
		t.Fatal(err)
	}
	if postGot != 1 || putGot != 0 {
		t.Fatalf("no-op should not mutate; POST=%d PUT=%d", postGot, putGot)
	}

	// Changed IP: PUT against the existing record id.
	if err := cli.UpsertA(t.Context(), "host.example", "10.0.0.2"); err != nil {
		t.Fatal(err)
	}
	if putGot != 1 {
		t.Fatalf("expected one PUT; got %d", putGot)
	}
	if lastPutBody["content"] != "10.0.0.2" {
		t.Fatalf("put body: %v", lastPutBody)
	}
}

func TestDetectBridgeIPEnvOverride(t *testing.T) {
	t.Setenv("BRIDGE_PUBLIC_IP", "192.168.42.7")
	if got := DetectBridgeIP(); got != "192.168.42.7" {
		t.Fatalf("env override: got %q", got)
	}
}

// ---------- helpers ----------

// rewriteHostTransport sends every request to `dest`, preserving path +
// query but swapping the host. Used by the CFDnsClient test so the
// real CF base URL (api.cloudflare.com) is redirected to the httptest
// server without touching the client constructor.
type rewriteHostTransport struct {
	dest  string
	inner http.RoundTripper
}

func (t *rewriteHostTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	// Compose: dest URL + original path + original query.
	req.URL.Scheme = "http"
	req.URL.Host = strings.TrimPrefix(t.dest, "http://")
	req.Host = req.URL.Host
	return t.inner.RoundTrip(req)
}

func cfOK(w http.ResponseWriter, result any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"success": true,
		"errors":  []any{},
		"result":  result,
	})
}

func readJSON(t *testing.T, r io.Reader) map[string]any {
	t.Helper()
	var v map[string]any
	if err := json.NewDecoder(r).Decode(&v); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	return v
}

// writeFakeCert writes a self-signed PEM with NotAfter at `expiry`.
// Just enough for certNeedsRenewal to parse it.
func writeFakeCert(t *testing.T, dst string, expiry time.Time) []byte {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "fake"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     expiry,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &priv.PublicKey, priv)
	if err != nil {
		t.Fatal(err)
	}
	out := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	if err := os.WriteFile(dst, out, 0o600); err != nil {
		t.Fatal(err)
	}
	return out
}
