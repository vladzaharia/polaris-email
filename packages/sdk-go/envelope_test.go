package polarissdk

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestParseWebhookEnvelopeOK(t *testing.T) {
	body := []byte(`{"event_id":"01H","event":"message.received","occurred_at":"2024-01-02T03:04:05Z","message":{"id":"01M","mailbox_id":"01MB","direction":"in","status":"delivered"}}`)
	env, err := ParseWebhookEnvelope(body)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if env.EventID != "01H" || env.Event != "message.received" || env.OccurredAt != "2024-01-02T03:04:05Z" {
		t.Fatalf("envelope = %+v", env)
	}
	if env.Message.ID != "01M" || env.Message.Direction != "in" {
		t.Fatalf("message = %+v", env.Message)
	}
}

func TestParseWebhookEnvelopeBadJSON(t *testing.T) {
	if _, err := ParseWebhookEnvelope([]byte("not-json")); err == nil {
		t.Fatal("expected parse error")
	}
}

// TestVerifyAndParseWebhookOK covers the happy path: the signature
// canonicalizes, verification succeeds, and the body parses.
func TestVerifyAndParseWebhookOK(t *testing.T) {
	secret := []byte("test-secret")
	body := []byte(`{"event_id":"01H","event":"message.received","occurred_at":"2024-01-02T03:04:05Z","message":{"id":"01M","mailbox_id":"01MB","direction":"in","status":"delivered"}}`)
	ts := "1700000000000"
	nonce := "ABCDEFGHJKMNPQRSTVWXYZ01"
	sig, err := Sign(CanonicalInput{
		Direction: DirectionWebhook,
		Method:    "POST",
		Path:      "/hook",
		Query:     "",
		TS:        ts,
		Nonce:     nonce,
		Body:      body,
	}, secret)
	if err != nil {
		t.Fatal(err)
	}
	tsInt := int64(1700000000000)
	env, res := VerifyAndParseWebhook(VerifyInput{
		Direction: DirectionWebhook,
		Method:    "POST",
		Path:      "/hook",
		Headers: map[string]string{
			"x-polaris-ts":    ts,
			"x-polaris-nonce": nonce,
			"x-polaris-sig":   sig,
		},
		Body:   body,
		Secret: secret,
		Now:    time.UnixMilli(tsInt),
	})
	if !res.OK {
		t.Fatalf("verify failed: %+v", res)
	}
	if env == nil || env.Event != "message.received" {
		t.Fatalf("env = %+v", env)
	}
}

// TestVerifyAndParseWebhookBadBody returns a non-OK result when verification
// passes but the body isn't valid JSON. The Code is HeaderInvalid since the
// envelope shape itself is invalid.
func TestVerifyAndParseWebhookBadBody(t *testing.T) {
	secret := []byte("s")
	body := []byte("not-json-at-all")
	ts := "1700000000000"
	nonce := "ABCDEFGHJKMNPQRSTVWXYZ01"
	sig, err := Sign(CanonicalInput{
		Direction: DirectionWebhook,
		Method:    "POST",
		Path:      "/hook",
		TS:        ts, Nonce: nonce, Body: body,
	}, secret)
	if err != nil {
		t.Fatal(err)
	}
	env, res := VerifyAndParseWebhook(VerifyInput{
		Direction: DirectionWebhook,
		Method:    "POST",
		Path:      "/hook",
		Headers: map[string]string{
			"x-polaris-ts":    ts,
			"x-polaris-nonce": nonce,
			"x-polaris-sig":   sig,
		},
		Body:   body,
		Secret: secret,
		Now:    time.UnixMilli(1700000000000),
	})
	if env != nil {
		t.Fatal("expected nil envelope")
	}
	if res.OK {
		t.Fatal("expected verify result OK=false on bad body")
	}
}

func TestVerifyAndParseWebhookBadSig(t *testing.T) {
	body := []byte(`{}`)
	ts := "1700000000000"
	nonce := "ABCDEFGHJKMNPQRSTVWXYZ01"
	env, res := VerifyAndParseWebhook(VerifyInput{
		Direction: DirectionWebhook,
		Method:    "POST",
		Path:      "/hook",
		Headers: map[string]string{
			"x-polaris-ts":    ts,
			"x-polaris-nonce": nonce,
			"x-polaris-sig":   hex.EncodeToString(make([]byte, 32)),
		},
		Body:   body,
		Secret: []byte("s"),
		Now:    time.UnixMilli(1700000000000),
	})
	if env != nil {
		t.Fatal("envelope must be nil on bad sig")
	}
	if res.OK {
		t.Fatal("expected verify failure")
	}
	if res.Code != CodeInvalidSignature {
		t.Fatalf("expected invalid_signature, got %s", res.Code)
	}
}

// Empty nonce (or ts/sig) is reported with an explicit empty-* error message
// rather than the misleading "crlf" message.
func TestVerifyEmptyNonceMessage(t *testing.T) {
	body := []byte("{}")
	res := VerifyWebhook(VerifyInput{
		Direction: DirectionWebhook,
		Method:    "POST",
		Path:      "/hook",
		Headers: map[string]string{
			"x-polaris-ts":    "1700000000000",
			"x-polaris-nonce": "",
			"x-polaris-sig":   hex.EncodeToString(make([]byte, 32)),
		},
		Body:   body,
		Secret: []byte("s"),
		Now:    time.UnixMilli(1700000000000),
	})
	if res.OK {
		t.Fatal("expected failure")
	}
	if res.Code != CodeHeaderInvalid {
		t.Fatalf("code = %s", res.Code)
	}
	if !strings.Contains(res.Err.Error(), "nonce empty") {
		t.Fatalf("expected 'nonce empty' message, got %q", res.Err.Error())
	}
}

// GetMessage returns *APIError{Code: "not_found", Status: 404} when the
// bulk-get response omits the requested id, so callers can distinguish via
// errors.As without string matching.
func TestGetMessageNotFoundReturnsTypedAPIError(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/messages/get", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(BulkGetResponse{
			Data:     []Message{},
			NotFound: []string{"missing-id"},
		})
	})
	c, srv := newTestClient(t, mux)
	defer srv.Close()

	_, err := c.GetMessage(context.Background(), "missing-id")
	if err == nil {
		t.Fatal("expected error")
	}
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected *APIError, got %T: %v", err, err)
	}
	if apiErr.Code != "not_found" || apiErr.Status != 404 {
		t.Fatalf("apiErr = %+v", apiErr)
	}
}

// Compile-time guard that httptest is referenced (avoids unused-import on
// future test refactors).
var _ = httptest.NewServer
