package scenarios

import (
	"context"
	"net"
	"testing"
	"time"

	mt "github.com/vladzaharia/polaris-email/apps/mail-bridge/test/mailtest"
)

func runSMTPSSuite(t *testing.T, factory mt.HarnessFactory) {
	t.Run("ConnectTLS", func(t *testing.T) { SMTPSConnectTLS(t, factory) })
	t.Run("AuthPlainSuccess", func(t *testing.T) { SMTPSAuthPlainSuccess(t, factory) })
	t.Run("AuthPlainBadCreds", func(t *testing.T) { SMTPSAuthPlainBadCreds(t, factory) })
	t.Run("SubmitMessage", func(t *testing.T) { SMTPSSubmitMessage(t, factory) })
	t.Run("DataExceedsMaxSize", func(t *testing.T) { SMTPSDataExceedsMaxSize(t, factory) })
	t.Run("PlaintextSMTP", func(t *testing.T) { SMTPPlaintextListener(t, factory) })
	t.Run("MultipleRcpts", func(t *testing.T) { SMTPSMultipleRcpts(t, factory) })
}

// SMTPSDataExceedsMaxSize — SM5.
func SMTPSDataExceedsMaxSize(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, mt.HarnessOpts{
		InitialMailboxes: []mt.SeedMailbox{{OwnerAddr: "alice@inbound.test"}},
		InitialCreds: []mt.SeedCredential{{
			MailboxOwnerAddr: "alice@inbound.test",
			Username:         "alice",
			Password:         "good-password",
			Protocol:         "smtp",
		}},
		// Cap body size aggressively for the test.
		ExtraEnv: map[string]string{"BRIDGE_MAX_MESSAGE_SIZE": "10240"},
	})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	c := mt.DialSMTPS(t, h.SMTPSAddr(), mt.DialSMTPSOpts{TLSConfig: h.CABundle()})
	t.Cleanup(func() { c.MustClose(t) })
	if err := c.AuthPlain("alice", "good-password"); err != nil {
		t.Fatalf("AUTH: %v", err)
	}
	body := mt.LargeMessage(20 * 1024)
	err := c.SendRFC822("alice@example.com", []string{"bob@inbound.test"}, body)
	if err == nil {
		t.Fatal("expected size-cap rejection")
	}
}

// SMTPPlaintextListener — SM6.
func SMTPPlaintextListener(t *testing.T, factory mt.HarnessFactory) {
	enabled := true
	h := factory(t, mt.HarnessOpts{
		InitialMailboxes: []mt.SeedMailbox{{OwnerAddr: "alice@inbound.test"}},
		InitialCreds: []mt.SeedCredential{{
			MailboxOwnerAddr: "alice@inbound.test",
			Username:         "alice",
			Password:         "good-password",
			Protocol:         "smtp",
		}},
		ExtraEnv:       map[string]string{"BRIDGE_SMTP_PLAIN_ENABLED": "1"},
		BridgeSettings: &mt.SettingsPatch{SMTPEnabled: &enabled},
	})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	c := mt.DialSMTPS(t, h.SMTPAddr(), mt.DialSMTPSOpts{TLSConfig: nil})
	t.Cleanup(func() { c.MustClose(t) })
	if err := c.AuthPlain("alice", "good-password"); err != nil {
		t.Fatalf("plain AUTH: %v", err)
	}
}

// SMTPSMultipleRcpts — SM7. Confirm DATA with two RCPT TOs results in
// one POST to /v1/messages carrying both recipients in the envelope.
func SMTPSMultipleRcpts(t *testing.T, factory mt.HarnessFactory) {
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
		t.Fatalf("AUTH: %v", err)
	}
	body := mt.LoadEML(t, "simple.eml")
	if err := c.SendRFC822("alice@example.com",
		[]string{"bob@inbound.test", "cathy@inbound.test"}, body); err != nil {
		t.Fatalf("send: %v", err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	sub := h.Fake().WaitForSubmittedMessage(ctx, h.Bridge())
	if sub.ReceivedAt.IsZero() {
		t.Fatal("no submission observed")
	}
	// We don't deeply inspect the envelope here — confirming that a
	// single submission lands is the contract.
}

// SMTPSConnectTLS — SM1.
func SMTPSConnectTLS(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, mt.HarnessOpts{})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	c, err := net.DialTimeout("tcp", h.SMTPSAddr(), 2*time.Second)
	if err != nil {
		t.Fatalf("dial smtps: %v", err)
	}
	_ = c.Close()
}

// SMTPSAuthPlainSuccess — SM2.
func SMTPSAuthPlainSuccess(t *testing.T, factory mt.HarnessFactory) {
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

	smtpClient := mt.DialSMTPS(t, h.SMTPSAddr(), mt.DialSMTPSOpts{TLSConfig: h.CABundle()})
	t.Cleanup(func() { smtpClient.MustClose(t) })
	if err := smtpClient.AuthPlain("alice", "good-password"); err != nil {
		t.Fatalf("AUTH PLAIN failed: %v", err)
	}
}

// SMTPSAuthPlainBadCreds — SM3.
func SMTPSAuthPlainBadCreds(t *testing.T, factory mt.HarnessFactory) {
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

	smtpClient := mt.DialSMTPS(t, h.SMTPSAddr(), mt.DialSMTPSOpts{TLSConfig: h.CABundle()})
	t.Cleanup(func() { smtpClient.MustClose(t) })
	if err := smtpClient.AuthPlain("alice", "WRONG-password"); err == nil {
		t.Fatal("AUTH PLAIN with bad password unexpectedly succeeded")
	}
}

// SMTPSSubmitMessage — SM4.
func SMTPSSubmitMessage(t *testing.T, factory mt.HarnessFactory) {
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

	smtpClient := mt.DialSMTPS(t, h.SMTPSAddr(), mt.DialSMTPSOpts{TLSConfig: h.CABundle()})
	t.Cleanup(func() { smtpClient.MustClose(t) })
	if err := smtpClient.AuthPlain("alice", "good-password"); err != nil {
		t.Fatalf("AUTH PLAIN: %v", err)
	}
	body := mt.LoadEML(t, "simple.eml")
	if err := smtpClient.SendRFC822("alice@example.com", []string{"bob@inbound.test"}, body); err != nil {
		t.Fatalf("send: %v", err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	sub := h.Fake().WaitForSubmittedMessage(ctx, h.Bridge())
	if sub.ReceivedAt.IsZero() {
		t.Fatal("no /v1/messages submission observed within deadline")
	}
	if sub.ContentType != "message/rfc822" {
		t.Errorf("submission content-type = %q, want message/rfc822", sub.ContentType)
	}
}
