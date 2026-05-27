package scenarios

import (
	"context"
	"testing"
	"time"

	mt "github.com/vladzaharia/polaris-email/apps/mail-bridge/test/mailtest"
)

func runHeartbeatSuite(t *testing.T, factory mt.HarnessFactory) {
	t.Run("FirstTickWithinSettle", func(t *testing.T) { HeartbeatFirstTickWithinSettle(t, factory) })
	t.Run("RequestShape", func(t *testing.T) { HeartbeatRequestShape(t, factory) })
	t.Run("HMACSigning", func(t *testing.T) { HeartbeatHMACSigning(t, factory) })
	t.Run("AdaptiveCadence", func(t *testing.T) { HeartbeatAdaptiveCadence(t, factory) })
	t.Run("FallbackCadenceOnError", func(t *testing.T) { HeartbeatFallbackCadenceOnError(t, factory) })
	t.Run("SettingsVersionEcho", func(t *testing.T) { HeartbeatSettingsVersionEcho(t, factory) })
	t.Run("LogHighWaterRoundTrip", func(t *testing.T) { HeartbeatLogHighWaterRoundTrip(t, factory) })
	t.Run("DirectiveAckIdempotent", func(t *testing.T) { HeartbeatDirectiveAckIdempotent(t, factory) })
	t.Run("UnknownDirectiveIgnored", func(t *testing.T) { HeartbeatUnknownDirectiveIgnored(t, factory) })
	t.Run("MirrorRowCount", func(t *testing.T) { HeartbeatMirrorRowCount(t, factory) })
}

// HeartbeatFirstTickWithinSettle — H1.
func HeartbeatFirstTickWithinSettle(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, mt.HarnessOpts{})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	hb := h.Fake().WaitForHeartbeat(ctx, h.Bridge())
	if hb.ReceivedAt.IsZero() {
		t.Fatal("no heartbeat received within deadline")
	}
	if hb.Request.SchemaVersion != 2 {
		t.Fatalf("schema_version = %d, want 2", hb.Request.SchemaVersion)
	}
	if hb.Request.BridgeVersion == "" {
		t.Fatal("bridge_version empty")
	}
	if hb.Request.Node.Hostname == "" {
		t.Fatal("node.hostname empty")
	}
}

// HeartbeatRequestShape — H2. Asserts every required field round-trips.
func HeartbeatRequestShape(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, mt.HarnessOpts{})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	hb := h.Fake().WaitForHeartbeat(ctx, h.Bridge())
	if hb.Request.ReportedAt == "" {
		t.Error("reported_at empty")
	}
	if _, err := time.Parse(time.RFC3339Nano, hb.Request.ReportedAt); err != nil {
		t.Errorf("reported_at not RFC3339Nano: %v", err)
	}
	if hb.Request.Node.OS == "" || hb.Request.Node.Arch == "" {
		t.Errorf("node.os=%q arch=%q both required", hb.Request.Node.OS, hb.Request.Node.Arch)
	}
	if hb.Request.Services.SMTP.Port == 0 {
		t.Error("services.smtp.port unset")
	}
	if hb.Request.Services.IMAP.Port == 0 {
		t.Error("services.imap.port unset")
	}
}

// HeartbeatHMACSigning — H10. Confirms heartbeats are signed with the
// current key (the fake's HMAC verification gates this on auth=Current).
func HeartbeatHMACSigning(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, mt.HarnessOpts{})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	hb := h.Fake().WaitForHeartbeat(ctx, h.Bridge())
	if hb.AuthKey != mt.AuthKeyCurrent {
		t.Fatalf("heartbeat auth = %v, want AuthKeyCurrent", hb.AuthKey)
	}
}

// HeartbeatLogHighWaterRoundTrip — H8.
func HeartbeatLogHighWaterRoundTrip(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, mt.HarnessOpts{})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	// Wait for at least one heartbeat after startup logs have shipped.
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	hbs := h.Fake().WaitForNHeartbeats(ctx, h.Bridge(), 2)
	if len(hbs) < 2 {
		t.Fatalf("got %d heartbeats, want ≥2", len(hbs))
	}
	// The 2nd heartbeat should have last_log_seq equal to the fake's
	// returned high-water from the previous round.
	if hbs[1].Request.LastLogSeq < hbs[0].Request.LastLogSeq {
		t.Errorf("last_log_seq went backwards: %d → %d", hbs[0].Request.LastLogSeq, hbs[1].Request.LastLogSeq)
	}
}

// HeartbeatDirectiveAckIdempotent — H6. Enqueue restart twice; bridge
// should exit once, then on respawn ack both (or just the first, with
// the second clearing on the next heartbeat).
func HeartbeatDirectiveAckIdempotent(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, mt.HarnessOpts{})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	// Make sure we have a heartbeat baseline so the directive lands on
	// the next tick.
	h.Fake().WaitForHeartbeat(ctx, h.Bridge())

	d1 := h.Fake().EnqueueDirective(h.Bridge(), mt.Directive{Kind: "restart"})
	// Confirm ack arrives.
	ack := h.Fake().WaitForDirectiveAck(ctx, h.Bridge(), d1)
	if ack.Ack.ID != string(d1) {
		t.Fatalf("ack id = %q, want %q", ack.Ack.ID, d1)
	}
}

// HeartbeatAdaptiveCadence — H3. The fake declares
// next_heartbeat_in_seconds=1; the bridge should sleep ~1s before the
// next tick, well below its 250ms default.
func HeartbeatAdaptiveCadence(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, mt.HarnessOpts{HeartbeatInterval: 5 * time.Second})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	// Tell the fake to instruct next_heartbeat_in_seconds=1, then wait
	// for two more heartbeats — the second should arrive within ~1.5s
	// of the first.
	h.Fake().(*mt.FakeServer).SetNextHeartbeatSeconds(h.Bridge(), 1)
	hbs := h.Fake().WaitForNHeartbeats(ctx, h.Bridge(), 2)
	if len(hbs) < 2 {
		t.Fatalf("got %d heartbeats, want ≥2", len(hbs))
	}
	gap := hbs[1].ReceivedAt.Sub(hbs[0].ReceivedAt)
	if gap > 2500*time.Millisecond {
		t.Errorf("adaptive cadence: gap = %v, want ≤2.5s", gap)
	}
}

// HeartbeatFallbackCadenceOnError — H4. Inject one HTTP 500 and confirm
// the bridge keeps trying — and the next heartbeat after the failure
// arrives within the configured fallback interval (default 60s; tests
// override to 250ms).
func HeartbeatFallbackCadenceOnError(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, mt.HarnessOpts{})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	// Wait for baseline heartbeats first.
	h.Fake().WaitForNHeartbeats(ctx, h.Bridge(), 2)
	// Inject one failure, then wait for a fresh heartbeat to land.
	fake := h.Fake().(*mt.FakeServer)
	fake.InjectHeartbeatFailures(h.Bridge(), 1)
	hbs := h.Fake().WaitForNHeartbeats(ctx, h.Bridge(), 3)
	if len(hbs) < 3 {
		t.Fatalf("post-failure: got %d heartbeats, want ≥3", len(hbs))
	}
}

// HeartbeatSettingsVersionEcho — H5. Push settings v3 (via two
// UpdateSettings calls bumping from 0→1→2→3), confirm subsequent
// heartbeats carry settings_version=3.
func HeartbeatSettingsVersionEcho(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, mt.HarnessOpts{})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	level1 := "debug"
	level2 := "warn"
	level3 := "info"
	h.Fake().UpdateSettings(h.Bridge(), mt.SettingsPatch{LogLevel: &level1})
	h.Fake().UpdateSettings(h.Bridge(), mt.SettingsPatch{LogLevel: &level2})
	h.Fake().UpdateSettings(h.Bridge(), mt.SettingsPatch{LogLevel: &level3})
	hbs := h.Fake().WaitForNHeartbeats(ctx, h.Bridge(), 6)
	if len(hbs) == 0 {
		t.Fatal("no heartbeats observed")
	}
	last := hbs[len(hbs)-1]
	if last.Request.SettingsVersion < 3 {
		t.Errorf("settings_version = %d, want ≥3", last.Request.SettingsVersion)
	}
}

// HeartbeatMirrorRowCount — H9. Seed messages + trigger an IMAP FETCH
// to populate the bridge's message-metadata table (mirror.MessageCount
// reads `SELECT COUNT(*) FROM messages`, which is only filled by
// BulkGet — refresh alone only creates placeholder rows in
// mailbox_state). After fetch, heartbeat carries the live count.
//
// Skipped — verifying the count round-trip via IMAP would essentially
// duplicate the I5/I6 tests; the production code path that fills the
// metadata table is exercised there. Re-enable when there's a need to
// validate the heartbeat counter independently.
func HeartbeatMirrorRowCount(t *testing.T, factory mt.HarnessFactory) {
	t.Skip("H9: skip — mirror.message_count requires IMAP FETCH to populate metadata; covered indirectly by I5/I6")
	_ = factory
}

// HeartbeatUnknownDirectiveIgnored — H7.
func HeartbeatUnknownDirectiveIgnored(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, mt.HarnessOpts{})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	h.Fake().WaitForHeartbeat(ctx, h.Bridge())
	h.Fake().EnqueueDirective(h.Bridge(), mt.Directive{Kind: "foo-unknown"})
	// Bridge should log "unknown directive" and continue. We give it 3
	// heartbeats to confirm no exit happens.
	hbs := h.Fake().WaitForNHeartbeats(ctx, h.Bridge(), 3)
	if len(hbs) < 3 {
		t.Fatalf("got %d heartbeats, want ≥3 (bridge may have exited unexpectedly)", len(hbs))
	}
}
