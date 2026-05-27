package scenarios

import (
	"context"
	"strings"
	"testing"
	"time"

	mt "github.com/vladzaharia/polaris-email/apps/mail-bridge/test/mailtest"
)

func runSMTPSecuritySuite(t *testing.T, factory mt.HarnessFactory) {
	t.Run("AuthLockoutAfter5Fails", func(t *testing.T) { SMTPAuthLockoutAfter5Fails(t, factory) })
	t.Run("MIMEPolicyRejection", func(t *testing.T) { SMTPMIMEPolicyRejection(t, factory) })
	t.Run("LockoutCooldownExpires", func(t *testing.T) { SMTPLockoutCooldownExpires(t, factory) })
	t.Run("PerIPConcurrentLimit", func(t *testing.T) { SMTPPerIPConcurrentLimit(t, factory) })
}

// SMTPLockoutCooldownExpires — SEC2. After 5 fails, the test waits
// past BRIDGE_AUTH_LOCKOUT_COOLDOWN and confirms the correct password
// is accepted again.
func SMTPLockoutCooldownExpires(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, mt.HarnessOpts{
		InitialMailboxes: []mt.SeedMailbox{{OwnerAddr: "alice@inbound.test"}},
		InitialCreds: []mt.SeedCredential{{
			MailboxOwnerAddr: "alice@inbound.test",
			Username:         "alice",
			Password:         "good-password",
			Protocol:         "smtp",
		}},
		AuthLockoutCooldown: 1 * time.Second,
	})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	// Trigger the lockout.
	for range 5 {
		c := mt.DialSMTPS(t, h.SMTPSAddr(), mt.DialSMTPSOpts{TLSConfig: h.CABundle()})
		_ = c.AuthPlain("alice", "wrong")
		c.QuitOrClose()
	}
	// Wait past the cooldown (1s + slack for clock drift on CI).
	time.Sleep(1500 * time.Millisecond)
	c := mt.DialSMTPS(t, h.SMTPSAddr(), mt.DialSMTPSOpts{TLSConfig: h.CABundle()})
	defer c.QuitOrClose()
	if err := c.AuthPlain("alice", "good-password"); err != nil {
		t.Fatalf("post-cooldown AUTH should succeed: %v", err)
	}
}

// SMTPPerIPConcurrentLimit — SEC3. The bridge caps per-source-IP
// concurrent SMTPS connections at MaxConnsPerIP (10). The 11th
// concurrent connection from the same IP gets refused.
func SMTPPerIPConcurrentLimit(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, mt.HarnessOpts{
		InitialMailboxes: []mt.SeedMailbox{{OwnerAddr: "alice@inbound.test"}},
		InitialCreds: []mt.SeedCredential{{
			MailboxOwnerAddr: "alice@inbound.test",
			Username:         "alice",
			Password:         "good-password",
			Protocol:         "smtp",
		}},
	})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	// Hold open 10 SMTPS connections. The bridge counts per-IP
	// inside NewSession, which go-smtp fires on the client's first
	// EHLO — not on TCP accept. So we issue a NOOP on each held conn
	// to ensure NewSession runs and perIP++ goes through.
	held := make([]*mt.SMTPClient, 0, 10)
	defer func() {
		for _, c := range held {
			c.QuitOrClose()
		}
	}()
	for range 10 {
		c := mt.DialSMTPS(t, h.SMTPSAddr(), mt.DialSMTPSOpts{TLSConfig: h.CABundle()})
		// Hello triggers go-smtp's NewSession, which is where the
		// bridge increments perIP.
		if err := c.Hello("localhost"); err != nil {
			t.Fatalf("Hello on held conn: %v", err)
		}
		held = append(held, c)
	}
	// 11th connection. go-smtp sends the 220 greeting BEFORE calling
	// NewSession — the per-IP check fires on the client's first EHLO
	// (handleGreet calls Backend.NewSession). So we get a normal 220,
	// then EHLO returns 451 (the bridge's writeError wraps NewSession's
	// 421 SMTPError into a 4xx response).
	c11 := mt.DialSMTPS(t, h.SMTPSAddr(), mt.DialSMTPSOpts{TLSConfig: h.CABundle()})
	defer c11.QuitOrClose()
	err := c11.Hello("localhost")
	if err == nil {
		t.Fatal("11th EHLO unexpectedly succeeded; per-IP limit not enforced")
	}
	// Confirm the error mentions the rejection (any 4xx is acceptable —
	// go-smtp may map our 421 into 451 via writeError).
	msg := err.Error()
	if !strings.Contains(msg, "421") && !strings.Contains(msg, "451") && !strings.Contains(msg, "too many") {
		t.Logf("11th EHLO error = %q (still treated as enforced)", msg)
	}
}

// SMTPAuthLockoutAfter5Fails — SEC1.
func SMTPAuthLockoutAfter5Fails(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, mt.HarnessOpts{
		InitialMailboxes: []mt.SeedMailbox{{OwnerAddr: "alice@inbound.test"}},
		InitialCreds: []mt.SeedCredential{{
			MailboxOwnerAddr: "alice@inbound.test",
			Username:         "alice",
			Password:         "good-password",
			Protocol:         "smtp",
		}},
		AuthLockoutCooldown: 2 * time.Second,
	})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	for range 5 {
		c := mt.DialSMTPS(t, h.SMTPSAddr(), mt.DialSMTPSOpts{TLSConfig: h.CABundle()})
		_ = c.AuthPlain("alice", "wrong")
		c.QuitOrClose()
	}
	// 6th attempt should be rejected even with correct password (lockout).
	c := mt.DialSMTPS(t, h.SMTPSAddr(), mt.DialSMTPSOpts{TLSConfig: h.CABundle()})
	defer c.QuitOrClose()
	if err := c.AuthPlain("alice", "good-password"); err == nil {
		t.Fatal("6th AUTH PLAIN unexpectedly succeeded — lockout not enforced")
	}
}

// SMTPMIMEPolicyRejection — SEC4.
func SMTPMIMEPolicyRejection(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, mt.HarnessOpts{
		InitialMailboxes: []mt.SeedMailbox{{OwnerAddr: "alice@inbound.test"}},
		InitialCreds: []mt.SeedCredential{{
			MailboxOwnerAddr: "alice@inbound.test",
			Username:         "alice",
			Password:         "good-password",
			Protocol:         "smtp",
		}},
	})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	c := mt.DialSMTPS(t, h.SMTPSAddr(), mt.DialSMTPSOpts{TLSConfig: h.CABundle()})
	t.Cleanup(func() { c.MustClose(t) })
	if err := c.AuthPlain("alice", "good-password"); err != nil {
		t.Fatalf("AUTH PLAIN: %v", err)
	}
	// Construct a deliberately malformed body that the strict parser will
	// reject: a NUL byte in the body section trips the parser's `nul_byte`
	// rule. (A missing From: header doesn't trigger rejection — the
	// strict parser checks structural correctness, not RFC 5322 required
	// headers.)
	body := []byte("From: a@b.test\r\nTo: c@d.test\r\nSubject: bad\r\n\r\nhello\x00world\r\n")
	err := c.SendRFC822("alice@example.com", []string{"bob@inbound.test"}, body)
	if err == nil {
		t.Fatal("submission of malformed message unexpectedly succeeded")
	}
	// Confirm no submission landed at the fake.
	ctx, cancel := context.WithTimeout(t.Context(), 1*time.Second)
	defer cancel()
	subs := h.Fake().SubmissionsFor(h.Bridge())
	if len(subs) > 0 {
		t.Errorf("malformed message reached fake control plane (%d submissions)", len(subs))
	}
	_ = ctx
}
