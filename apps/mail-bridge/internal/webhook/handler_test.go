package webhook

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/push"
)

const testPath = "/internal/webhook/message-received"

func signRequest(secret, body []byte) (ts, nonce, sig string) {
	ts = strconv.FormatInt(time.Now().UnixMilli(), 10)
	nonce = "ABCDEFGHJKMNPQRS"
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
	sig = hex.EncodeToString(mac.Sum(nil))
	return
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

type testSink struct {
	id      string
	deliver func() error
}

func (s *testSink) ID() string                       { return s.id }
func (s *testSink) Deliver(_ push.StateChange) error { return s.deliver() }
