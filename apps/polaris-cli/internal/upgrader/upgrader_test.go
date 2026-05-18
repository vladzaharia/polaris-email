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
	// Pass a non-"dev" version so the build-info heuristic doesn't
	// short-circuit to local before we get to the sentinel check.
	// (When the test binary itself runs under `go test` inside the
	// polaris-email checkout, isDevBuild would otherwise return true
	// since the test binary inherits the polaris-cli main module.)
	got, err := DetectInstallMethod(dir, "v9.9.9")
	if err != nil {
		t.Fatal(err)
	}
	if got != InstallMethodCurl {
		t.Errorf("DetectInstallMethod with sentinel = %q; want curl", got)
	}
}

func TestDetectInstallMethodLocalFromDevBuild(t *testing.T) {
	// Running `go test` inside the polaris-cli module: the test
	// binary's debug.BuildInfo.Main.Path matches polarisModulePath.
	// With runningVersion == "dev" (the package default), detection
	// should return InstallMethodLocal without needing a sentinel
	// file or the `apps/polaris-cli/bin/` path match.
	got, err := DetectInstallMethod(t.TempDir(), "dev")
	if err != nil {
		t.Fatal(err)
	}
	// On systems where the test binary's debug.BuildInfo isn't
	// populated (rare; usually only when stripped or when the test
	// binary lives in $GOPATH/pkg) we'd see InstallMethodUnknown.
	// Either is acceptable; what's not acceptable is curl/brew —
	// those would mean the heuristic mis-fired.
	if got != InstallMethodLocal && got != InstallMethodUnknown {
		t.Errorf("dev-build detection = %q; want local or unknown", got)
	}
}

func TestDetectInstallMethodSemverSkipsLocalHeuristic(t *testing.T) {
	// A runtime version that's a real semver tag should NOT trigger
	// the dev-build heuristic — it means goreleaser injected the
	// ldflag, so the binary came from a tarball install. With no
	// sentinel + no path match, we expect unknown.
	got, err := DetectInstallMethod(t.TempDir(), "v0.1.2")
	if err != nil {
		t.Fatal(err)
	}
	// Path-match could still fire if the test binary happens to live
	// at `apps/polaris-cli/bin/...` — accept that.
	if got != InstallMethodUnknown && got != InstallMethodLocal {
		t.Errorf("semver-version detection = %q; expected unknown (or local from path match)", got)
	}
}

func TestDefaultChannelFor(t *testing.T) {
	cases := map[InstallMethod]Channel{
		InstallMethodLocal:   ChannelLocal,
		InstallMethodBrew:    ChannelStable,
		InstallMethodCurl:    ChannelStable,
		InstallMethodUnknown: ChannelStable,
	}
	for method, want := range cases {
		if got := DefaultChannelFor(method); got != want {
			t.Errorf("DefaultChannelFor(%q) = %q, want %q", method, got, want)
		}
	}
}

func TestResolveChannel(t *testing.T) {
	// Explicit operator preference wins.
	if got := ResolveChannel("dev", InstallMethodLocal); got != ChannelDev {
		t.Errorf("explicit dev should beat local default: got %q", got)
	}
	if got := ResolveChannel("stable", InstallMethodLocal); got != ChannelStable {
		t.Errorf("explicit stable should beat local default: got %q", got)
	}
	// Empty state — fall through to install-method default.
	if got := ResolveChannel("", InstallMethodLocal); got != ChannelLocal {
		t.Errorf("local install method should default to local: got %q", got)
	}
	if got := ResolveChannel("", InstallMethodCurl); got != ChannelStable {
		t.Errorf("curl install method should default to stable: got %q", got)
	}
}
