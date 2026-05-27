package scenarios

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	polarissdk "github.com/polaris-mail/polaris-sdk-go"
	mt "github.com/vladzaharia/polaris-email/apps/mail-bridge/test/mailtest"
)

func runWebhookSuite(t *testing.T, factory mt.HarnessFactory) {
	t.Run("HappyPath", func(t *testing.T) { WebhookHappyPath(t, factory) })
	t.Run("BadSignature", func(t *testing.T) { WebhookBadSignature(t, factory) })
	t.Run("Replay", func(t *testing.T) { WebhookReplay(t, factory) })
	t.Run("ClockSkew", func(t *testing.T) { WebhookClockSkew(t, factory) })
	t.Run("MissingSecret", func(t *testing.T) { WebhookMissingSecret(t, factory) })
}

// WebhookReplay — W3. POST the same body+ts+nonce twice; the second
// MUST be rejected (replay protection).
func WebhookReplay(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, mt.HarnessOpts{
		InitialMailboxes: []mt.SeedMailbox{{OwnerAddr: "alice@inbound.test"}},
	})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	if !h.Fake().(*mt.FakeServer).WaitForWebhookBootstrap(ctx, h.Bridge()) {
		t.Fatal("webhook bootstrap never completed")
	}
	fake := h.Fake().(*mt.FakeServer)
	url := fake.WebhookURL(h.Bridge())
	secret := fake.WebhookSecret(h.Bridge())

	body := []byte(`{"event_id":"e-replay","event":"message.received","occurred_at":"2026-05-27T00:00:00Z","message":{"id":"msg-x","mailbox_id":"mb-1"}}`)
	ts := polarissdk.NowMillis()
	nonce, _ := polarissdk.GenerateNonce()
	sig, err := polarissdk.Sign(polarissdk.CanonicalInput{
		Direction: polarissdk.DirectionWebhook,
		Method:    "POST", Path: pathOnly(url), Query: "",
		TS: ts, Nonce: nonce, Body: body,
	}, secret)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	status1, err := fake.DeliverWebhookRaw(ctx, h.Bridge(), body, ts, nonce, sig)
	if err != nil || status1 >= 300 {
		t.Fatalf("first delivery: status=%d err=%v", status1, err)
	}
	status2, _ := fake.DeliverWebhookRaw(ctx, h.Bridge(), body, ts, nonce, sig)
	if status2 != 409 {
		t.Errorf("replay status = %d, want 409", status2)
	}
}

// WebhookClockSkew — W4. ts >5min old → 401.
func WebhookClockSkew(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, mt.HarnessOpts{
		InitialMailboxes: []mt.SeedMailbox{{OwnerAddr: "alice@inbound.test"}},
	})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	if !h.Fake().(*mt.FakeServer).WaitForWebhookBootstrap(ctx, h.Bridge()) {
		t.Fatal("webhook bootstrap never completed")
	}
	fake := h.Fake().(*mt.FakeServer)
	url := fake.WebhookURL(h.Bridge())
	secret := fake.WebhookSecret(h.Bridge())

	body := []byte(`{"event_id":"e-skew","event":"message.received","occurred_at":"2026-05-27T00:00:00Z","message":{"id":"msg-x","mailbox_id":"mb-1"}}`)
	staleMS := time.Now().Add(-10 * time.Minute).UnixMilli()
	ts := strconv.FormatInt(staleMS, 10)
	nonce, _ := polarissdk.GenerateNonce()
	sig, _ := polarissdk.Sign(polarissdk.CanonicalInput{
		Direction: polarissdk.DirectionWebhook,
		Method:    "POST", Path: pathOnly(url), Query: "",
		TS: ts, Nonce: nonce, Body: body,
	}, secret)
	status, _ := fake.DeliverWebhookRaw(ctx, h.Bridge(), body, ts, nonce, sig)
	if status != 401 {
		t.Errorf("stale-ts status = %d, want 401", status)
	}
}

// WebhookMissingSecret — W5. With no InitialMailboxes the bridge's
// webhook bootstrap registers no subs, so the handler stays
// fail-closed and returns 503 on every request.
func WebhookMissingSecret(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, mt.HarnessOpts{})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	// POST raw bytes to the bridge's webhook URL with arbitrary headers
	// (no secret bootstrapped so verify never even runs — 503 first).
	url := "http://" + h.WebhookAddr() + "/internal/webhook/message-received"
	req, err := http.NewRequestWithContext(ctx, "POST", url, strings.NewReader(`{}`))
	if err != nil {
		t.Fatalf("new req: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Polaris-Ts", polarissdk.NowMillis())
	nonce, _ := polarissdk.GenerateNonce()
	req.Header.Set("X-Polaris-Nonce", nonce)
	req.Header.Set("X-Polaris-Sig", strings.Repeat("0", 64))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("missing-secret status = %d, want 503", resp.StatusCode)
	}
}

// pathOnly extracts the path component from a URL (no scheme/host).
func pathOnly(rawURL string) string {
	for _, scheme := range []string{"https://", "http://"} {
		if strings.HasPrefix(rawURL, scheme) {
			rest := rawURL[len(scheme):]
			if idx := strings.Index(rest, "/"); idx >= 0 {
				return rest[idx:]
			}
			return "/"
		}
	}
	return rawURL
}

// WebhookHappyPath — W1. Deliver a signed message.received webhook and
// confirm the bridge accepts it (HTTP 204).
func WebhookHappyPath(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, mt.HarnessOpts{
		InitialMailboxes: []mt.SeedMailbox{{OwnerAddr: "alice@inbound.test"}},
	})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	if !h.Fake().(*mt.FakeServer).WaitForWebhookBootstrap(ctx, h.Bridge()) {
		t.Fatal("webhook bootstrap never completed")
	}

	mailboxes := h.Fake().Bridges()
	if len(mailboxes) == 0 {
		t.Fatal("no bridges registered")
	}
	mb := mt.Mailbox{ID: "mb-1"} // placeholder; the bridge accepts any mailbox in the envelope
	if err := h.Fake().DeliverWebhook(ctx, h.Bridge(), mt.WebhookPayload{
		Event:   "message.received",
		Message: polarissdk.Message{ID: "msg-test-1", MailboxID: mb.ID, Subject: "from webhook"},
	}); err != nil {
		t.Fatalf("deliver webhook: %v", err)
	}
}

// WebhookBadSignature — W2.
func WebhookBadSignature(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, mt.HarnessOpts{
		InitialMailboxes: []mt.SeedMailbox{{OwnerAddr: "alice@inbound.test"}},
	})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	if !h.Fake().(*mt.FakeServer).WaitForWebhookBootstrap(ctx, h.Bridge()) {
		t.Fatal("webhook bootstrap never completed")
	}

	url := h.Fake().(*mt.FakeServer).WebhookURL(h.Bridge())
	if url == "" {
		t.Fatal("no webhook url")
	}
	req, err := http.NewRequestWithContext(ctx, "POST", url, strings.NewReader(`{}`))
	if err != nil {
		t.Fatalf("new req: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Polaris-Ts", polarissdk.NowMillis())
	nonce, _ := polarissdk.GenerateNonce()
	req.Header.Set("X-Polaris-Nonce", nonce)
	req.Header.Set("X-Polaris-Sig", "0000000000000000000000000000000000000000000000000000000000000000")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("bad-sig POST status = %d, want 401", resp.StatusCode)
	}
}
