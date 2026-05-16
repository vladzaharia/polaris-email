package webhook

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	polarissdk "github.com/polaris-email/polaris-sdk-go"

	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/push"
)

const testPath = "/internal/webhook/message-received"

func signRequest(secret, body []byte) (ts, nonce, sig string) {
	ts = strconv.FormatInt(time.Now().UnixMilli(), 10)
	nonce = "ABCDEFGHJKMNPQRS"
	return signRequestWith(secret, body, ts, nonce)
}

func signRequestWith(secret, body []byte, ts, nonce string) (string, string, string) {
	sum := sha256.Sum256(body)
	bodyHex := hex.EncodeToString(sum[:])
	canonical := strings.Join([]string{
		"polaris-webhook",
		"POST",
		testPath,
		"",
		ts,
		nonce,
		bodyHex,
	}, "\n")
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(canonical))
	sig := hex.EncodeToString(mac.Sum(nil))
	return ts, nonce, sig
}

func TestHandlerValidSignature(t *testing.T) {
	mgr := push.New()
	type capture struct {
		mailbox string
	}
	got := capture{}
	sink := &testSink{deliver: func() error { got.mailbox = "mb1"; return nil }, id: "s1"}
	mgr.Subscribe("mb1", sink)

	h := &Handler{Manager: mgr, Secret: []byte("shhh"), Path: testPath}
	body := []byte(`{"id":"e1","event":"message.received","data":{"message_id":"m1","mailbox_id":"mb1"}}`)
	ts, nonce, sig := signRequest(h.Secret, body)
	r := httptest.NewRequest(http.MethodPost, testPath, bytes.NewReader(body))
	r.Header.Set("X-Polaris-Ts", ts)
	r.Header.Set("X-Polaris-Nonce", nonce)
	r.Header.Set("X-Polaris-Sig", sig)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusNoContent {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	if got.mailbox != "mb1" {
		t.Fatal("broadcast did not reach the sink")
	}
}

func TestHandlerInvalidSignature(t *testing.T) {
	h := &Handler{Manager: push.New(), Secret: []byte("shhh"), Path: testPath}
	r := httptest.NewRequest(http.MethodPost, testPath, bytes.NewReader([]byte(`{}`)))
	r.Header.Set("X-Polaris-Ts", strconv.FormatInt(time.Now().UnixMilli(), 10))
	r.Header.Set("X-Polaris-Nonce", "ABCDEFGHJKMNPQRS")
	r.Header.Set("X-Polaris-Sig", "deadbeef")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

// TestHandlerEmptySecretRejected proves the 2d fix that wires the secret
// from bootstrap into the handler. When Secret is nil/empty the handler
// MUST reject (503) — pre-fix it accepted because VerifyWebhook with an
// empty key signed against nothing.
func TestHandlerEmptySecretRejected(t *testing.T) {
	h := &Handler{Manager: push.New(), Path: testPath}
	body := []byte(`{}`)
	// Sign with an empty secret to mimic a hypothetical attacker who knows
	// the handler's secret is empty — it MUST still be rejected.
	ts, nonce, sig := signRequestWith([]byte{}, body, strconv.FormatInt(time.Now().UnixMilli(), 10), "ABCDEFGHJKMNPQRS")
	r := httptest.NewRequest(http.MethodPost, testPath, bytes.NewReader(body))
	r.Header.Set("X-Polaris-Ts", ts)
	r.Header.Set("X-Polaris-Nonce", nonce)
	r.Header.Set("X-Polaris-Sig", sig)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 with empty secret, got %d body=%s", w.Code, w.Body.String())
	}
}

// TestHandlerSetSecret proves SetSecret atomically swaps the verifier key,
// closing the bootstrap-completion gap.
func TestHandlerSetSecret(t *testing.T) {
	h := &Handler{Manager: push.New(), Path: testPath}
	body := []byte(`{"id":"e1","event":"message.received","data":{"message_id":"m1","mailbox_id":"mb1"}}`)

	// Pre-SetSecret: 503.
	ts, nonce, sig := signRequest([]byte("supersecret"), body)
	r := httptest.NewRequest(http.MethodPost, testPath, bytes.NewReader(body))
	r.Header.Set("X-Polaris-Ts", ts)
	r.Header.Set("X-Polaris-Nonce", nonce)
	r.Header.Set("X-Polaris-Sig", sig)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("pre-SetSecret expected 503 got %d", w.Code)
	}

	// Post-SetSecret: 204.
	h.SetSecret([]byte("supersecret"))
	r2 := httptest.NewRequest(http.MethodPost, testPath, bytes.NewReader(body))
	r2.Header.Set("X-Polaris-Ts", ts)
	r2.Header.Set("X-Polaris-Nonce", nonce)
	r2.Header.Set("X-Polaris-Sig", sig)
	w2 := httptest.NewRecorder()
	h.ServeHTTP(w2, r2)
	if w2.Code != http.StatusNoContent {
		t.Fatalf("post-SetSecret expected 204 got %d body=%s", w2.Code, w2.Body.String())
	}
}

// TestHandlerReplayRejected proves the in-memory dedup catches an attacker
// who captures one signed request and resends it with the same headers.
func TestHandlerReplayRejected(t *testing.T) {
	h := &Handler{Manager: push.New(), Secret: []byte("shhh"), Path: testPath}
	body := []byte(`{"id":"e1","event":"message.received","data":{"message_id":"m1","mailbox_id":"mb1"}}`)
	ts, nonce, sig := signRequest(h.Secret, body)

	// First request → 204.
	send := func() *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, testPath, bytes.NewReader(body))
		r.Header.Set("X-Polaris-Ts", ts)
		r.Header.Set("X-Polaris-Nonce", nonce)
		r.Header.Set("X-Polaris-Sig", sig)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	if got := send().Code; got != http.StatusNoContent {
		t.Fatalf("first request: want 204, got %d", got)
	}
	// Replay → 409.
	if got := send().Code; got != http.StatusConflict {
		t.Fatalf("replay: want 409, got %d", got)
	}
}

// TestHandlerDifferentNoncesAccepted confirms two distinct nonces with the
// same body and timestamp both go through (we are not key-collapsing on ts
// alone).
func TestHandlerDifferentNoncesAccepted(t *testing.T) {
	h := &Handler{Manager: push.New(), Secret: []byte("shhh"), Path: testPath}
	body := []byte(`{"id":"e1","event":"message.received","data":{"message_id":"m1","mailbox_id":"mb1"}}`)
	ts := strconv.FormatInt(time.Now().UnixMilli(), 10)
	for _, nonce := range []string{"NONCE0123456789A", "NONCE0123456789B"} {
		_, _, sig := signRequestWith(h.Secret, body, ts, nonce)
		r := httptest.NewRequest(http.MethodPost, testPath, bytes.NewReader(body))
		r.Header.Set("X-Polaris-Ts", ts)
		r.Header.Set("X-Polaris-Nonce", nonce)
		r.Header.Set("X-Polaris-Sig", sig)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusNoContent {
			t.Fatalf("nonce=%q: expected 204, got %d body=%s", nonce, w.Code, w.Body.String())
		}
	}
}

// TestBootstrapRunReturnsSecret verifies bootstrap returns the per-sub
// secret string from the SDK's CreateWebhookSub response, and that
// FirstSecret threads it back to the caller. This is the unit-level proof
// that wiring is correct end-to-end (the e2e wire-up happens in
// cmd/polaris-bridge/main.go).
func TestBootstrapRunReturnsSecret(t *testing.T) {
	var listed atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/admin/webhook-subs"):
			listed.Add(1)
			_, _ = w.Write([]byte(`{"data":[]}`))
		case r.Method == http.MethodPost && r.URL.Path == "/v1/admin/webhook-subs":
			_, _ = w.Write([]byte(`{"id":"sub-1","secret":"sshhhh"}`))
		default:
			t.Errorf("unexpected request: %s", mustDump(r))
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	c := polarissdk.NewClient(srv.URL)
	c.BridgeID = "bridge-test"
	c.BridgeSecret = []byte("test-secret")
	b := &Bootstrap{Client: c, PublicURL: "https://bridge.example.com", Path: testPath}

	results, err := b.Run(context.Background(), []string{"mb-1"})
	if err != nil {
		t.Fatalf("bootstrap.Run: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("results = %d, want 1", len(results))
	}
	if results[0].Secret != "sshhhh" {
		t.Fatalf("secret = %q, want %q", results[0].Secret, "sshhhh")
	}
	if got := FirstSecret(results); string(got) != "sshhhh" {
		t.Fatalf("FirstSecret = %q, want %q", string(got), "sshhhh")
	}
}

func mustDump(r *http.Request) string {
	b, err := httputil.DumpRequest(r, true)
	if err != nil {
		return err.Error()
	}
	return string(b)
}

type testSink struct {
	id      string
	deliver func() error
}

func (s *testSink) ID() string                       { return s.id }
func (s *testSink) Deliver(_ push.StateChange) error { return s.deliver() }
