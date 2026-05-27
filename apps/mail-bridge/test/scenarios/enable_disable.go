package scenarios

import (
	"context"
	"net"
	"testing"
	"time"

	mt "github.com/vladzaharia/polaris-email/apps/mail-bridge/test/mailtest"
)

func runEnableDisableSuite(t *testing.T, factory mt.HarnessFactory) {
	t.Run("DisableSuspendsListeners", func(t *testing.T) { EnableDisableSuspendsListeners(t, factory) })
	t.Run("ReenableResumesListeners", func(t *testing.T) { EnableReenableResumesListeners(t, factory) })
	t.Run("HeartbeatContinuesWhileDisabled", func(t *testing.T) { EnableHeartbeatContinuesWhileDisabled(t, factory) })
	t.Run("DisableReasonLogged", func(t *testing.T) { EnableDisableReasonLogged(t, factory) })
}

// EnableDisableSuspendsListeners — ED1. Disable the bridge via admin
// and confirm a fresh SMTPS dial gets refused within a couple of
// heartbeat cycles.
func EnableDisableSuspendsListeners(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, mt.HarnessOpts{})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	// Confirm SMTPS dial works first.
	if !smtpsReachable(t, h.SMTPSAddr(), h.CABundle() != nil) {
		t.Skip("SMTPS not reachable in pre-disable state; harness may be plaintext-only")
	}
	h.Fake().DisableBridge(h.Bridge())
	// Wait for 2 heartbeats so the disable directive has been applied.
	h.Fake().WaitForNHeartbeats(ctx, h.Bridge(), 2)
	// Now SMTPS should refuse new connections.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if !smtpsReachable(t, h.SMTPSAddr(), false) {
			return // pass
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("SMTPS listener still reachable after Disable + 2 heartbeats")
}

// EnableReenableResumesListeners — ED2.
func EnableReenableResumesListeners(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, mt.HarnessOpts{})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	ctx, cancel := context.WithTimeout(t.Context(), 12*time.Second)
	defer cancel()
	h.Fake().DisableBridge(h.Bridge())
	h.Fake().WaitForNHeartbeats(ctx, h.Bridge(), 2)
	h.Fake().EnableBridge(h.Bridge())
	h.Fake().WaitForNHeartbeats(ctx, h.Bridge(), 2)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if smtpsReachable(t, h.SMTPSAddr(), false) {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("SMTPS listener never came back after Enable")
}

// EnableHeartbeatContinuesWhileDisabled — ED3.
func EnableHeartbeatContinuesWhileDisabled(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, mt.HarnessOpts{})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	h.Fake().DisableBridge(h.Bridge())
	hbs := h.Fake().WaitForNHeartbeats(ctx, h.Bridge(), 3)
	if len(hbs) < 3 {
		t.Fatalf("got %d heartbeats while disabled, want ≥3 (bridge appears to have exited)", len(hbs))
	}
}

// EnableDisableReasonLogged — ED4.
func EnableDisableReasonLogged(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, mt.HarnessOpts{})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	h.Fake().WaitForHeartbeat(ctx, h.Bridge())
	h.Fake().DisableBridge(h.Bridge())
	h.Fake().WaitForNHeartbeats(ctx, h.Bridge(), 2)
	mt.AssertLogContains(t, h.Fake().(*mt.FakeServer), h.Bridge(), "disabled_by_admin")
}

// smtpsReachable does a quick TCP dial and tries a tiny read to
// distinguish "listener accepting" from "listener gone but kernel
// port still bound" (which docker's port-proxy emulates for stopped
// container listeners — TCP dial succeeds, then the connection
// immediately drops). Returns true only if dial succeeded AND a 250ms
// read returns either bytes or a "would block" (i.e. listener is
// holding the connection open). false on dial-error or immediate-EOF.
func smtpsReachable(t *testing.T, addr string, _ bool) bool {
	t.Helper()
	c, err := net.DialTimeout("tcp", addr, 500*time.Millisecond)
	if err != nil {
		return false
	}
	defer c.Close()
	_ = c.SetReadDeadline(time.Now().Add(250 * time.Millisecond))
	buf := make([]byte, 1)
	n, err := c.Read(buf)
	if n > 0 {
		return true // got the SMTP greeting / TLS handshake bytes
	}
	if err == nil {
		return true
	}
	// On a docker proxy refusing a backed-out listener we get io.EOF.
	// On a real listener with no greeting yet (e.g. TLS handshake
	// hasn't started), we get a deadline-exceeded which we treat as
	// "still up".
	if nerr, ok := err.(net.Error); ok && nerr.Timeout() {
		return true
	}
	return false
}
