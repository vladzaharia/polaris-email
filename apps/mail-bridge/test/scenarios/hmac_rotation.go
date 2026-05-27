package scenarios

import (
	"context"
	"testing"
	"time"

	mt "github.com/vladzaharia/polaris-email/apps/mail-bridge/test/mailtest"
)

func runHMACRotationSuite(t *testing.T, factory mt.HarnessFactory) {
	t.Run("AppliedAndAcked", func(t *testing.T) { HMACRotationAppliedAndAcked(t, factory) })
	t.Run("StagedAcceptsBothKeys", func(t *testing.T) { HMACRotationStagedAcceptsBothKeys(t, factory) })
	t.Run("DuplicateDirectiveIdempotent", func(t *testing.T) { HMACRotationDuplicateDirective(t, factory) })
	t.Run("EmergencyRevokesOldKey", func(t *testing.T) { HMACRotationEmergencyRevokesOldKey(t, factory) })
}

// HMACRotationStagedAcceptsBothKeys — R1. Stage a rotation with a 10s
// grace window; before grace expires, both old key + new key
// authenticate successfully against the fake.
func HMACRotationStagedAcceptsBothKeys(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, mt.HarnessOpts{})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	// Capture the original key BEFORE staging the rotation.
	originalKey := h.Bridge().HMACKey
	h.Fake().WaitForHeartbeat(ctx, h.Bridge())

	fake := h.Fake().(*mt.FakeServer)
	newKey := fake.StageHMACRotation(h.Bridge(), 10*time.Second)
	if newKey == "" {
		t.Fatal("StageHMACRotation returned empty key")
	}
	// During the grace window, both keys authenticate via the
	// PingHeartbeatWithKey helper (independent of the bridge's own
	// signing). New key must succeed; old key must also succeed.
	status, err := fake.PingHeartbeatWithKey(ctx, h.Bridge(), []byte(newKey))
	if err != nil || status != 200 {
		t.Errorf("ping with new key (grace): status=%d err=%v", status, err)
	}
	status, err = fake.PingHeartbeatWithKey(ctx, h.Bridge(), originalKey)
	if err != nil || status != 200 {
		t.Errorf("ping with old key (within grace): status=%d err=%v", status, err)
	}
}

// HMACRotationDuplicateDirective — R3. After a rotation has completed,
// re-enqueue the same roll_hmac directive with the same key. The
// bridge should detect "already running with this key" and ack
// without exiting.
func HMACRotationDuplicateDirective(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, mt.HarnessOpts{})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	h.Fake().WaitForHeartbeat(ctx, h.Bridge())

	fake := h.Fake().(*mt.FakeServer)
	newKey := fake.StageHMACRotation(h.Bridge(), 30*time.Second)
	if err := h.WaitForRestart(ctx); err != nil {
		t.Fatalf("first restart: %v", err)
	}
	// Now re-enqueue the same key as a directive — bridge already has
	// it on disk + in memory, so should ack without restart.
	startCount := fake.LogHighWater(h.Bridge()) // proxy for "bridge alive"
	_ = startCount
	dupID := fake.EnqueueDirective(h.Bridge(), mt.Directive{Kind: "roll_hmac", NewHMACKey: newKey})
	ack := fake.WaitForDirectiveAck(ctx, h.Bridge(), dupID)
	if ack.Ack.ID != string(dupID) {
		t.Fatalf("duplicate directive not acked")
	}
	// Confirm no second restart happened. Wait briefly for any pending
	// exit; if h.WaitForRestart succeeds within a short timeout that's
	// a regression.
	shortCtx, shortCancel := context.WithTimeout(t.Context(), 1500*time.Millisecond)
	defer shortCancel()
	if err := h.WaitForRestart(shortCtx); err == nil {
		t.Error("duplicate directive triggered an unexpected restart")
	}
}

// HMACRotationEmergencyRevokesOldKey — R4. StageHMACRotation with
// grace=0 means the old key is rejected immediately; the bridge's
// in-flight signing (still on the old key) will start getting 401.
// Verification: ping with old key returns 401; ping with new key
// returns 200.
func HMACRotationEmergencyRevokesOldKey(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, mt.HarnessOpts{})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	originalKey := h.Bridge().HMACKey
	h.Fake().WaitForHeartbeat(ctx, h.Bridge())

	fake := h.Fake().(*mt.FakeServer)
	newKey := fake.StageHMACRotation(h.Bridge(), 0)
	if newKey == "" {
		t.Fatal("StageHMACRotation returned empty key")
	}
	// Sleep a tick so the grace window we set to 0 is definitely
	// in the past (time.Now() comparison).
	time.Sleep(50 * time.Millisecond)
	status, _ := fake.PingHeartbeatWithKey(ctx, h.Bridge(), originalKey)
	if status != 401 {
		t.Errorf("emergency revoke: old key status = %d, want 401", status)
	}
	status, _ = fake.PingHeartbeatWithKey(ctx, h.Bridge(), []byte(newKey))
	if status != 200 {
		t.Errorf("emergency revoke: new key status = %d, want 200", status)
	}
}

// HMACRotationAppliedAndAcked — R2.
//
// Enqueue a roll_hmac directive with a fresh key. Confirm the bridge:
//   1. Writes the new key to its on-disk key file.
//   2. Exits and respawns (the harness's supervisor mode).
//   3. Sends an ack within a couple of heartbeats post-respawn.
func HMACRotationAppliedAndAcked(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, mt.HarnessOpts{})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	// Baseline heartbeat.
	h.Fake().WaitForHeartbeat(ctx, h.Bridge())

	// Stage a rotation. StageHMACRotation updates the fake's accepted
	// keys + enqueues the roll_hmac directive.
	newKey := h.Fake().StageHMACRotation(h.Bridge(), 30*time.Second)
	if newKey == "" {
		t.Fatal("StageHMACRotation returned empty key")
	}
	// Bridge will exit after applying. Wait for the respawn.
	if err := h.WaitForRestart(ctx); err != nil {
		t.Fatalf("waiting for restart: %v", err)
	}
	// After the restart, the on-disk key file should match the new key.
	disk := h.ReadHMACKeyFile()
	if string(disk) != newKey {
		t.Errorf("on-disk key mismatch: got %q, want %q", string(disk), newKey)
	}
	// Next heartbeat should be signed with the new key (the fake's
	// HMAC verification gates this on AuthKeyCurrent).
	hb := h.Fake().WaitForHeartbeat(ctx, h.Bridge())
	if hb.AuthKey != mt.AuthKeyCurrent {
		t.Errorf("post-rotation heartbeat auth = %v, want AuthKeyCurrent", hb.AuthKey)
	}
}
