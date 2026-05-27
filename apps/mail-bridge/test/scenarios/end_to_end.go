package scenarios

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
	mt "github.com/vladzaharia/polaris-email/apps/mail-bridge/test/mailtest"
)

func runEndToEndSuite(t *testing.T, factory mt.HarnessFactory) {
	t.Run("SMTPInboundToIMAPRead", func(t *testing.T) { E2ESMTPInboundToIMAPRead(t, factory) })
	t.Run("Idempotency", func(t *testing.T) { E2EIdempotency(t, factory) })
	t.Run("IMAPIdleNotification", func(t *testing.T) { E2EIMAPIdleNotification(t, factory) })
	t.Run("WebhookFanoutMultipleSubs", func(t *testing.T) { E2EWebhookFanout(t, factory) })
	t.Run("R2BodyFetch", func(t *testing.T) { E2ER2BodyFetch(t, factory) })
}

// E2EIMAPIdleNotification — connect IMAPS, LOGIN, SELECT INBOX,
// enter IDLE; submit a message via SMTPS. The bridge's webhook
// handler should refresh the mirror + push.Manager.Broadcast, which
// the IDLE goroutine surfaces to the client as `* 1 EXISTS`.
func E2EIMAPIdleNotification(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, e2eFullOpts())
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	if h.Fake() == nil {
		t.Skip("E2EIMAPIdleNotification: requires fake control plane (auto-route)")
	}
	fake := h.Fake().(*mt.FakeServer)
	fake.EnableAutoRoute(h.Bridge())
	bootCtx, bootCancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer bootCancel()
	if !fake.WaitForWebhookBootstrap(bootCtx, h.Bridge()) {
		t.Fatal("webhook bootstrap never completed")
	}

	// IMAP client with unilateral handler that buffers EXISTS events.
	existsCh := make(chan uint32, 4)
	c := mt.DialIMAPSWithOptions(t, h.IMAPSAddr(), mt.DialIMAPSOpts{TLSConfig: h.CABundle()},
		&imapclient.Options{
			UnilateralDataHandler: &imapclient.UnilateralDataHandler{
				Mailbox: func(m *imapclient.UnilateralDataMailbox) {
					if m.NumMessages != nil {
						existsCh <- *m.NumMessages
					}
				},
			},
		})
	t.Cleanup(func() { c.MustClose(t) })
	if err := c.Login("alice", "good-password").Wait(); err != nil {
		t.Fatalf("LOGIN: %v", err)
	}
	if _, err := c.Select("INBOX", nil).Wait(); err != nil {
		t.Fatalf("SELECT: %v", err)
	}
	idleCmd, err := c.Idle()
	if err != nil {
		t.Fatalf("IDLE: %v", err)
	}
	// Submit a message via SMTPS in a goroutine while we're idling.
	subject := "idle-notify-" + uniqueSuffix()
	go func() {
		body := buildEML(subject, "alice@example.com", "alice@inbound.test")
		sc := mt.DialSMTPS(t, h.SMTPSAddr(), mt.DialSMTPSOpts{TLSConfig: h.CABundle()})
		defer sc.QuitOrClose()
		_ = sc.AuthPlain("alice", "good-password")
		_ = sc.SendRFC822("alice@example.com", []string{"alice@inbound.test"}, body)
	}()

	// Wait for the EXISTS notification.
	select {
	case n := <-existsCh:
		if n == 0 {
			t.Errorf("EXISTS notification with NumMessages=0")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("no EXISTS notification received via IDLE within 10s")
	}

	if err := idleCmd.Close(); err != nil {
		t.Errorf("IDLE close: %v", err)
	}
	_ = idleCmd.Wait()
}

// E2EWebhookFanout — register two webhook subscriptions for the
// same mailbox (the bridge's bootstrap currently only registers one,
// so we drive a second sub via the fake's setup hook), submit a
// message, verify both subs see it.
//
// Skipped today: the fake's auto-route only delivers to the
// bridge that submitted (one sub). True multi-sub fanout is the
// control-plane responsibility (services/api FANOUT_QUEUE), so this
// test is more meaningful in mailtest_contract.
func E2EWebhookFanout(t *testing.T, factory mt.HarnessFactory) {
	t.Skip("E2EWebhookFanout: multi-sub fanout is a control-plane responsibility (services/api FANOUT_QUEUE); meaningful in mailtest_contract where the real Worker handles distribution")
	_ = factory
}

// E2ER2BodyFetch — submit a message large enough that the body lives
// at the public R2 URL rather than inline; the IMAP FETCH BODY[]
// path retrieves via http.Get with the configured size cap.
//
// Skipped today: the fake doesn't currently host an R2-like
// content-addressed endpoint and the bridge's URL validation rejects
// non-R2 hosts. Implementing this would require either a fake R2
// host or a bridge-side test knob; deferring until real R2
// integration is wanted in tests.
func E2ER2BodyFetch(t *testing.T, factory mt.HarnessFactory) {
	t.Skip("E2ER2BodyFetch: requires fake R2 host with the bridge's allowed-host gate; deferring")
	_ = factory
}

// e2eFullOpts returns the seeding both end-to-end tests need: one
// mailbox with paired smtp + imap creds for "alice".
func e2eFullOpts() mt.HarnessOpts {
	return mt.HarnessOpts{
		InitialMailboxes: []mt.SeedMailbox{{OwnerAddr: "alice@inbound.test"}},
		InitialCreds: []mt.SeedCredential{
			{
				MailboxOwnerAddr: "alice@inbound.test",
				Username:         "alice", Password: "good-password", Protocol: "smtp",
			},
			{
				MailboxOwnerAddr: "alice@inbound.test",
				Username:         "alice", Password: "good-password", Protocol: "imap",
			},
		},
	}
}

// E2ESMTPInboundToIMAPRead — the full inbound roundtrip. Send via
// SMTPS to the bridge, let the fake auto-route the message into
// alice's mailbox + fire a `message.received` webhook back to the
// bridge, then connect via IMAPS and confirm the message appears.
func E2ESMTPInboundToIMAPRead(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, e2eFullOpts())
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	// Auto-routing only works against the in-process fake. Tier 3
	// (real Worker) handles routing differently.
	if h.Fake() == nil {
		t.Skip("E2ESMTPInboundToIMAPRead: requires fake control plane (auto-route)")
	}
	fake := h.Fake().(*mt.FakeServer)
	fake.EnableAutoRoute(h.Bridge())

	// Wait for the webhook bootstrap so the fake can fire the routed
	// webhook against the bridge.
	bootCtx, bootCancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer bootCancel()
	if !fake.WaitForWebhookBootstrap(bootCtx, h.Bridge()) {
		t.Fatal("webhook bootstrap never completed")
	}

	// Send a unique subject so the IMAP-side assertion is unambiguous.
	subject := "e2e-roundtrip-" + uniqueSuffix()
	body := buildEML(subject, "alice@example.com", "alice@inbound.test")
	smtpClient := mt.DialSMTPS(t, h.SMTPSAddr(), mt.DialSMTPSOpts{TLSConfig: h.CABundle()})
	if err := smtpClient.AuthPlain("alice", "good-password"); err != nil {
		t.Fatalf("SMTP AUTH: %v", err)
	}
	if err := smtpClient.SendRFC822("alice@example.com", []string{"alice@inbound.test"}, body); err != nil {
		t.Fatalf("SMTP send: %v", err)
	}
	smtpClient.QuitOrClose()

	// Now connect IMAP and poll for the new subject to appear. The
	// poll is necessary because auto-route → webhook → refresh → mirror
	// happens asynchronously.
	imapClient := mt.DialIMAPS(t, h.IMAPSAddr(), mt.DialIMAPSOpts{TLSConfig: h.CABundle()})
	t.Cleanup(func() { imapClient.MustClose(t) })
	if err := imapClient.Login("alice", "good-password").Wait(); err != nil {
		t.Fatalf("IMAP LOGIN: %v", err)
	}
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		sel, err := imapClient.Select("INBOX", nil).Wait()
		if err != nil {
			t.Fatalf("SELECT: %v", err)
		}
		if sel.NumMessages == 0 {
			time.Sleep(200 * time.Millisecond)
			continue
		}
		// Fetch envelopes and look for our subject.
		msgs, err := imapClient.Fetch(imap.SeqSetNum(1, sel.NumMessages), &imap.FetchOptions{Envelope: true}).Collect()
		if err != nil {
			t.Fatalf("FETCH: %v", err)
		}
		for _, m := range msgs {
			if m.Envelope != nil && m.Envelope.Subject == subject {
				return // pass
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("never observed message with subject %q via IMAP within 8s", subject)
}

// E2EIdempotency — submit the same RFC822 (same Message-ID header)
// twice and assert that the bridge issues distinct Idempotency-Key
// headers based on the Message-ID, so the control plane can dedupe.
// In this harness we just verify the bridge sees the same idempotency
// key for both submissions (production-side dedup is the API's job).
func E2EIdempotency(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, e2eFullOpts())
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	if h.Fake() == nil {
		t.Skip("E2EIdempotency: requires fake control plane")
	}

	messageID := "dedup-" + uniqueSuffix()
	body := buildEMLWithMessageID(messageID, "alice@example.com", "alice@inbound.test")

	// First submission.
	c1 := mt.DialSMTPS(t, h.SMTPSAddr(), mt.DialSMTPSOpts{TLSConfig: h.CABundle()})
	if err := c1.AuthPlain("alice", "good-password"); err != nil {
		t.Fatalf("AUTH1: %v", err)
	}
	if err := c1.SendRFC822("alice@example.com", []string{"alice@inbound.test"}, body); err != nil {
		t.Fatalf("send1: %v", err)
	}
	c1.QuitOrClose()

	// Second submission of the SAME body.
	c2 := mt.DialSMTPS(t, h.SMTPSAddr(), mt.DialSMTPSOpts{TLSConfig: h.CABundle()})
	if err := c2.AuthPlain("alice", "good-password"); err != nil {
		t.Fatalf("AUTH2: %v", err)
	}
	if err := c2.SendRFC822("alice@example.com", []string{"alice@inbound.test"}, body); err != nil {
		t.Fatalf("send2: %v", err)
	}
	c2.QuitOrClose()

	// Both submissions should reach the fake and both should carry
	// the SAME `Idempotency-Key` header (derived from Message-ID per
	// the bridge's forwarder.idempotencyKey).
	subs := mustWaitForNSubmissions(t, h.Fake().(*mt.FakeServer), h.Bridge(), 2, 5*time.Second)
	if len(subs) < 2 {
		t.Fatalf("got %d submissions, want ≥2", len(subs))
	}
	k1 := subs[0].Headers["Idempotency-Key"]
	k2 := subs[1].Headers["Idempotency-Key"]
	if k1 == "" || k2 == "" {
		t.Fatalf("missing Idempotency-Key headers: %q %q", k1, k2)
	}
	if k1 != k2 {
		t.Errorf("idempotency keys differ for identical Message-IDs: %q vs %q", k1, k2)
	}
}

// -------- helpers --------

func uniqueSuffix() string {
	return time.Now().UTC().Format("150405.000000")
}

func buildEML(subject, from, to string) []byte {
	return []byte(strings.Join([]string{
		"From: " + from,
		"To: " + to,
		"Subject: " + subject,
		"Date: Mon, 27 May 2026 12:00:00 +0000",
		"Message-ID: <" + uniqueSuffix() + "-" + subject + "@e2e>",
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"e2e roundtrip body for " + subject,
		"",
	}, "\r\n"))
}

func buildEMLWithMessageID(messageID, from, to string) []byte {
	return []byte(strings.Join([]string{
		"From: " + from,
		"To: " + to,
		"Subject: idempotency-" + messageID,
		"Date: Mon, 27 May 2026 12:00:00 +0000",
		"Message-ID: <" + messageID + "@e2e>",
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"body for " + messageID,
		"",
	}, "\r\n"))
}

// mustWaitForNSubmissions polls SubmissionsFor until n submissions have
// arrived. Returns whatever it has after the deadline; assertion is up
// to the caller (len check).
func mustWaitForNSubmissions(t *testing.T, f *mt.FakeServer, b mt.Bridge, n int, timeout time.Duration) []mt.SubmittedMessage {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		subs := f.SubmissionsFor(b)
		if len(subs) >= n {
			return subs
		}
		time.Sleep(100 * time.Millisecond)
	}
	return f.SubmissionsFor(b)
}
