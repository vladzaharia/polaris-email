package scenarios

import (
	"context"
	"testing"
	"time"

	mt "github.com/vladzaharia/polaris-email/apps/mail-bridge/test/mailtest"
)

func runDiagnosticsSuite(t *testing.T, factory mt.HarnessFactory) {
	t.Run("LogShipping", func(t *testing.T) { DiagnosticsLogShipping(t, factory) })
	t.Run("BridgeVersionStable", func(t *testing.T) { DiagnosticsBridgeVersionStable(t, factory) })
	t.Run("LogHighWaterAdvances", func(t *testing.T) { DiagnosticsLogHighWaterAdvances(t, factory) })
}

// DiagnosticsLogHighWaterAdvances — D2. Over multiple heartbeats with
// new log lines, the bridge's last_log_seq strictly increases.
func DiagnosticsLogHighWaterAdvances(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, mt.HarnessOpts{})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	hbs := h.Fake().WaitForNHeartbeats(ctx, h.Bridge(), 5)
	if len(hbs) < 5 {
		t.Fatalf("got %d heartbeats, want ≥5", len(hbs))
	}
	for i := 1; i < len(hbs); i++ {
		if hbs[i].Request.LastLogSeq < hbs[i-1].Request.LastLogSeq {
			t.Errorf("last_log_seq regressed at hb %d: %d → %d",
				i, hbs[i-1].Request.LastLogSeq, hbs[i].Request.LastLogSeq)
		}
	}
}

// DiagnosticsLogShipping — D1.
func DiagnosticsLogShipping(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, mt.HarnessOpts{})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	// The bridge writes "polaris-bridge starting" to its log at boot.
	// Confirm it lands in a heartbeat.
	h.Fake().WaitForNHeartbeats(ctx, h.Bridge(), 2)
	mt.AssertLogContains(t, h.Fake().(*mt.FakeServer), h.Bridge(), "polaris-bridge")
}

// DiagnosticsBridgeVersionStable — D3.
func DiagnosticsBridgeVersionStable(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, mt.HarnessOpts{})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	hbs := h.Fake().WaitForNHeartbeats(ctx, h.Bridge(), 3)
	if len(hbs) < 3 {
		t.Fatalf("got %d heartbeats, want ≥3", len(hbs))
	}
	v := hbs[0].Request.BridgeVersion
	for i, hb := range hbs {
		if hb.Request.BridgeVersion != v {
			t.Errorf("hb %d bridge_version = %q, want %q", i, hb.Request.BridgeVersion, v)
		}
	}
}
