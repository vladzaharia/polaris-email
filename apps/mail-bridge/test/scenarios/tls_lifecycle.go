package scenarios

import (
	"context"
	"net"
	"testing"
	"time"

	mt "github.com/vladzaharia/polaris-email/apps/mail-bridge/test/mailtest"
)

func runTLSLifecycleSuite(t *testing.T, factory mt.HarnessFactory) {
	t.Run("PlaintextFallbackNoPEMs", func(t *testing.T) { TLSPlaintextFallback(t, factory) })
	t.Run("DualSMTPSandSMTP", func(t *testing.T) { TLSDualSMTPSandSMTP(t, factory) })
	t.Run("HotReloadOnPEMRewrite", func(t *testing.T) { TLSHotReloadOnPEMRewrite(t, factory) })
	t.Run("DualIMAPSandIMAP", func(t *testing.T) { TLSDualIMAPSandIMAP(t, factory) })
}

// TLSHotReloadOnPEMRewrite — T3. Dial SMTPS, capture peer cert
// serial; ReplaceCert with a fresh one; wait the reload interval;
// dial again, confirm new serial.
//
// Requires the harness to have a CA (skipped for WithoutTLS=true).
// Tests assume per-test BRIDGE_TLS_RELOAD_INTERVAL=1s (set by the
// inproc harness).
func TLSHotReloadOnPEMRewrite(t *testing.T, factory mt.HarnessFactory) {
	// We need the CA to mint a fresh cert. The mailtest_inproc factory
	// shares one package-level CA; the harness doesn't expose it
	// directly, so we mint a fresh CA for the replacement cert. The
	// bridge's TLS source loads from disk and doesn't care about CA
	// continuity — only that the cert files are syntactically valid
	// PEMs.
	h := factory(t, mt.HarnessOpts{TLSReloadInterval: 500 * time.Millisecond})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	if h.CABundle() == nil {
		t.Skip("WithoutTLS harness; T3 needs TLS")
	}
	// First dial — capture initial cert serial. We need a client tls
	// config that doesn't strictly verify the SAN, because the new
	// cert we install might have a different one.
	cfg := h.CABundle()
	cfg.InsecureSkipVerify = true
	serial1, err := mt.PeerCertSerial(t, h.SMTPSAddr(), cfg)
	if err != nil {
		t.Fatalf("first dial: %v", err)
	}
	// Mint a fresh cert from a brand-new CA + install it on disk.
	newCA, err := mt.MintCAStandalone()
	if err != nil {
		t.Fatalf("mint replacement CA: %v", err)
	}
	newCert := newCA.IssueServerCert(t, "smtps.test", "imaps.test", "localhost", "127.0.0.1")
	h.ReplaceCert(t, newCert)
	// Poll for the cert to change, up to 4× the reload interval. Each
	// dial triggers a GetCertificate, which forces a reload if the
	// cache is stale.
	var serial2 string
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		serial2, err = mt.PeerCertSerial(t, h.SMTPSAddr(), cfg)
		if err == nil && serial2 != serial1 {
			return // pass
		}
		time.Sleep(200 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("dial during rotation polling: %v", err)
	}
	t.Errorf("cert serial unchanged after replace + 4s poll: %s", serial1)
}

// TLSDualIMAPSandIMAP — T4.
func TLSDualIMAPSandIMAP(t *testing.T, factory mt.HarnessFactory) {
	enabled := true
	h := factory(t, mt.HarnessOpts{
		ExtraEnv: map[string]string{
			"BRIDGE_IMAP_ENABLED":       "1",
			"BRIDGE_IMAP_PLAIN_ENABLED": "1",
		},
		BridgeSettings: &mt.SettingsPatch{IMAPSEnabled: &enabled, IMAPEnabled: &enabled},
	})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	for _, addr := range []string{h.IMAPSAddr(), h.IMAPAddr()} {
		c, err := net.DialTimeout("tcp", addr, 2*time.Second)
		if err != nil {
			t.Errorf("dial %s: %v", addr, err)
			continue
		}
		_ = c.Close()
	}
}

// TLSPlaintextFallback — T1. Boot with WithoutTLS: bridge should bind
// listeners in plaintext mode and accept plain TCP.
func TLSPlaintextFallback(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, mt.HarnessOpts{WithoutTLS: true})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	c, err := net.DialTimeout("tcp", h.SMTPSAddr(), 2*time.Second)
	if err != nil {
		t.Fatalf("dial plain smtp on smtps port: %v", err)
	}
	_ = c.Close()
}

// TLSDualSMTPSandSMTP — T2. With both SMTPS and plain SMTP enabled,
// confirm both ports accept TCP connections.
func TLSDualSMTPSandSMTP(t *testing.T, factory mt.HarnessFactory) {
	smtpsEnabled := true
	smtpEnabled := true
	h := factory(t, mt.HarnessOpts{
		ExtraEnv: map[string]string{
			"BRIDGE_SMTPS_ENABLED":      "1",
			"BRIDGE_SMTP_PLAIN_ENABLED": "1",
		},
		BridgeSettings: &mt.SettingsPatch{SMTPSEnabled: &smtpsEnabled, SMTPEnabled: &smtpEnabled},
	})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	for _, addr := range []string{h.SMTPSAddr(), h.SMTPAddr()} {
		if addr == "" {
			t.Errorf("expected addr for dual-listener test, got empty")
			continue
		}
		c, err := net.DialTimeout("tcp", addr, 2*time.Second)
		if err != nil {
			t.Errorf("dial %s: %v", addr, err)
			continue
		}
		_ = c.Close()
	}
}
