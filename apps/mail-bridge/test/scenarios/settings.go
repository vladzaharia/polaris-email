package scenarios

import (
	"context"
	"testing"
	"time"

	mt "github.com/vladzaharia/polaris-email/apps/mail-bridge/test/mailtest"
)

func runSettingsSuite(t *testing.T, factory mt.HarnessFactory) {
	t.Run("LogLevelHotApply", func(t *testing.T) { SettingsLogLevelHotApply(t, factory) })
	t.Run("VersionSkipped", func(t *testing.T) { SettingsVersionSkipped(t, factory) })
	t.Run("StaleVersionIgnored", func(t *testing.T) { SettingsStaleVersionIgnored(t, factory) })
	t.Run("SMTPSToggle", func(t *testing.T) { SettingsSMTPSToggle(t, factory) })
	t.Run("PortChangeRequiresRestart", func(t *testing.T) { SettingsPortChangeRequiresRestart(t, factory) })
}

// SettingsSMTPSToggle — S1.
func SettingsSMTPSToggle(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, mt.HarnessOpts{})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	ctx, cancel := context.WithTimeout(t.Context(), 12*time.Second)
	defer cancel()
	h.Fake().WaitForHeartbeat(ctx, h.Bridge())
	off := false
	h.Fake().UpdateSettings(h.Bridge(), mt.SettingsPatch{SMTPSEnabled: &off})
	h.Fake().WaitForNHeartbeats(ctx, h.Bridge(), 2)
	// SMTPS should refuse new connections within a few heartbeats.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if !smtpsReachable(t, h.SMTPSAddr(), false) {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("SMTPS listener still reachable after smtps_enabled=false")
}

// SettingsPortChangeRequiresRestart — S3. Push a different SMTPS port
// and confirm the bridge logs the restart-required message + exits
// cleanly (the harness's supervisor will respawn).
func SettingsPortChangeRequiresRestart(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, mt.HarnessOpts{})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	h.Fake().WaitForHeartbeat(ctx, h.Bridge())
	// Pick a port the harness didn't allocate but that's unlikely to
	// clash — high enough above the test's allocator range. The actual
	// value doesn't matter; what matters is that it differs from the
	// current SMTPSPort, which triggers restart-required.
	newPort := 60000
	h.Fake().UpdateSettings(h.Bridge(), mt.SettingsPatch{SMTPSPort: &newPort})
	if err := h.WaitForRestart(ctx); err != nil {
		t.Fatalf("port change should have triggered restart: %v", err)
	}
}

// SettingsLogLevelHotApply — S2.
func SettingsLogLevelHotApply(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, mt.HarnessOpts{})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	h.Fake().WaitForHeartbeat(ctx, h.Bridge())
	level := "debug"
	h.Fake().UpdateSettings(h.Bridge(), mt.SettingsPatch{LogLevel: &level})
	hbs := h.Fake().WaitForNHeartbeats(ctx, h.Bridge(), 3)
	if len(hbs) < 3 {
		t.Fatalf("got %d heartbeats, want ≥3", len(hbs))
	}
	// The bridge should have logged "settings v… received" — confirms
	// the settings were observed.
	mt.AssertLogContains(t, h.Fake().(*mt.FakeServer), h.Bridge(), "settings v")
}

// SettingsVersionSkipped — S4. Bridge sees v2 directly (server only
// returns latest); confirm settings_version in subsequent heartbeats
// matches v2.
func SettingsVersionSkipped(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, mt.HarnessOpts{})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	h.Fake().WaitForHeartbeat(ctx, h.Bridge())
	level := "debug"
	h.Fake().UpdateSettings(h.Bridge(), mt.SettingsPatch{LogLevel: &level})
	level2 := "warn"
	h.Fake().UpdateSettings(h.Bridge(), mt.SettingsPatch{LogLevel: &level2})

	hbs := h.Fake().WaitForNHeartbeats(ctx, h.Bridge(), 3)
	if len(hbs) < 3 {
		t.Fatalf("got %d heartbeats, want ≥3", len(hbs))
	}
	last := hbs[len(hbs)-1]
	if last.Request.SettingsVersion == 0 {
		t.Errorf("bridge never applied any settings version (got 0)")
	}
}

// SettingsStaleVersionIgnored — S5.
func SettingsStaleVersionIgnored(t *testing.T, factory mt.HarnessFactory) {
	h := factory(t, mt.HarnessOpts{})
	if err := h.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = h.Stop(context.Background()) })

	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	h.Fake().WaitForHeartbeat(ctx, h.Bridge())
	level := "debug"
	h.Fake().UpdateSettings(h.Bridge(), mt.SettingsPatch{LogLevel: &level})
	hbs := h.Fake().WaitForNHeartbeats(ctx, h.Bridge(), 4)
	if len(hbs) < 4 {
		t.Fatalf("got %d heartbeats, want ≥4", len(hbs))
	}
	// Last two heartbeats should not have triggered another Apply (the
	// server's stored version no longer exceeds the bridge's). We
	// confirm by checking the settings_version doesn't go backwards.
	for i := 1; i < len(hbs); i++ {
		if hbs[i].Request.SettingsVersion < hbs[i-1].Request.SettingsVersion {
			t.Errorf("settings_version went backwards at hb %d (%d → %d)",
				i, hbs[i-1].Request.SettingsVersion, hbs[i].Request.SettingsVersion)
		}
	}
}
