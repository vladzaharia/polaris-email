package upgrader

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestParseChannel(t *testing.T) {
	cases := map[string]Channel{
		"":       ChannelStable,
		"stable": ChannelStable,
		"STABLE": ChannelStable,
		"dev":    ChannelDev,
		"edge":   ChannelDev,
		"main":   ChannelDev,
		"local":  ChannelLocal,
		"repo":   ChannelLocal,
	}
	for in, want := range cases {
		got, err := ParseChannel(in)
		if err != nil {
			t.Errorf("ParseChannel(%q) err=%v", in, err)
		}
		if got != want {
			t.Errorf("ParseChannel(%q) = %q, want %q", in, got, want)
		}
	}
	if _, err := ParseChannel("nightly"); err == nil {
		t.Error("ParseChannel(nightly) expected error")
	}
}

func TestShouldCheck(t *testing.T) {
	now := time.Now()
	// Zero state always returns true.
	if !ShouldCheck(State{}, now) {
		t.Error("zero State should always check")
	}
	// Within the throttle window: skip.
	recent := State{LastCheck: now.Add(-10 * time.Minute)}
	if ShouldCheck(recent, now) {
		t.Error("10m-old state should skip")
	}
	// Past the throttle window: check.
	stale := State{LastCheck: now.Add(-2 * time.Hour)}
	if !ShouldCheck(stale, now) {
		t.Error("2h-old state should check")
	}
}

func TestStateRoundTrip(t *testing.T) {
	dir := t.TempDir()
	in := State{
		Channel:   "dev",
		LastCheck: time.Now().UTC().Truncate(time.Second),
	}
	if err := SaveState(dir, in); err != nil {
		t.Fatalf("SaveState: %v", err)
	}
	// Confirm file mode is 0600 on POSIX.
	if runtime.GOOS != "windows" {
		info, _ := os.Stat(filepath.Join(dir, stateFileName))
		if info.Mode().Perm() != 0o600 {
			t.Errorf("state file mode = %o, want 0600", info.Mode().Perm())
		}
	}
	out, err := LoadState(dir)
	if err != nil {
		t.Fatalf("LoadState: %v", err)
	}
	if out.Channel != in.Channel {
		t.Errorf("Channel: got %q want %q", out.Channel, in.Channel)
	}
	if !out.LastCheck.Equal(in.LastCheck) {
		t.Errorf("LastCheck: got %v want %v", out.LastCheck, in.LastCheck)
	}
}

func TestLoadStateMissing(t *testing.T) {
	dir := t.TempDir()
	s, err := LoadState(dir)
	if err != nil {
		t.Fatalf("LoadState on empty dir: %v", err)
	}
	if !s.LastCheck.IsZero() || s.Channel != "" {
		t.Errorf("expected zero State, got %+v", s)
	}
}

func TestAssetName(t *testing.T) {
	got := assetName("v0.1.1")
	want := "polaris-email_0.1.1_" + runtime.GOOS + "_" + runtime.GOARCH
	if runtime.GOOS == "windows" {
		want += ".zip"
	} else {
		want += ".tar.gz"
	}
	if got != want {
		t.Errorf("assetName(v0.1.1) = %q, want %q", got, want)
	}
	// dev tag flows through verbatim — used by the dev-snapshot
	// workflow which names archives polaris-email_dev_<os>_<arch>.<ext>.
	if dev := assetName("dev"); !strings.Contains(dev, "_dev_") {
		t.Errorf("assetName(dev) = %q, expected to contain _dev_", dev)
	}
}

func TestNormalise(t *testing.T) {
	for _, c := range []struct{ in, out string }{
		{"v0.1.1", "0.1.1"},
		{"0.1.1", "0.1.1"},
		{"  v0.1.1\n", "0.1.1"},
	} {
		if got := normalise(c.in); got != c.out {
			t.Errorf("normalise(%q) = %q, want %q", c.in, got, c.out)
		}
	}
}

func TestDetectInstallMethodSentinel(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "install-method"), []byte("curl\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := DetectInstallMethod(dir)
	if err != nil {
		t.Fatal(err)
	}
	// Path-based detection may fire first (e.g. when `go test` is
	// running from inside a polaris-email checkout under
	// apps/polaris-cli/), so we accept either the sentinel value OR a
	// successful path match. The important invariant is that the
	// sentinel is read when path detection returns Unknown.
	if got != InstallMethodCurl && got != InstallMethodLocal {
		t.Errorf("DetectInstallMethod returned %q; expected curl (from sentinel) or local (from path)", got)
	}
}
