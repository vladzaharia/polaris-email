package wrangler

import (
	"context"
	"errors"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// fakeBinPath returns the absolute path to testdata/fake-wrangler.sh.
func fakeBinPath(t *testing.T) string {
	t.Helper()
	_, this, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not resolve test file path")
	}
	return filepath.Join(filepath.Dir(this), "testdata", "fake-wrangler.sh")
}

func TestRunWith_CapturesArgsAndExitZero(t *testing.T) {
	t.Parallel()
	bin := fakeBinPath(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	res, err := RunWith(ctx, bin, nil, "deploy", "--name", "foo")
	if err != nil {
		t.Fatalf("RunWith: %v", err)
	}
	if res.ExitCode != 0 {
		t.Errorf("ExitCode: want 0, got %d", res.ExitCode)
	}
	got := strings.TrimSpace(string(res.Stdout))
	if !strings.Contains(got, "deploy") || !strings.Contains(got, "--name") || !strings.Contains(got, "foo") {
		t.Errorf("stdout missing args: %q", got)
	}
}

func TestRunWith_NonZeroExitSurfacesStderr(t *testing.T) {
	t.Parallel()
	bin := fakeBinPath(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	res, err := RunWith(ctx, bin, nil, "fail")
	if err == nil {
		t.Fatal("want error on non-zero exit")
	}
	if res == nil {
		t.Fatal("Result should be populated even on exit≠0")
	}
	if res.ExitCode != 2 {
		t.Errorf("ExitCode: want 2, got %d", res.ExitCode)
	}
	if !strings.Contains(string(res.Stderr), "boom") {
		t.Errorf("stderr should contain 'boom', got %q", string(res.Stderr))
	}
	if !strings.Contains(err.Error(), "boom") {
		t.Errorf("error should echo stderr, got %v", err)
	}
}

func TestRunWith_BinaryNotInPATH(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()

	_, err := RunWith(ctx, "/no/such/binary-7913f7", nil, "anything")
	if err == nil {
		t.Fatal("want error for missing binary")
	}
	if !errors.Is(err, ErrNotInstalled) {
		t.Errorf("want ErrNotInstalled wrapped, got %v", err)
	}
}

func TestDetect_ParsesVersion(t *testing.T) {
	t.Parallel()
	bin := fakeBinPath(t)
	// We can't easily redirect Detect() (which calls Run() → exec.LookPath
	// for `wrangler`) without mucking with PATH. Test the regex directly
	// by calling RunWith and feeding its stdout through the same parsing
	// path Detect uses.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	res, err := RunWith(ctx, bin, nil, "--version")
	if err != nil {
		t.Fatalf("RunWith: %v", err)
	}
	match := versionPattern.FindStringSubmatch(string(res.Stdout))
	if len(match) < 2 || match[1] != "4.20.1" {
		t.Errorf("version parse: got %v from %q", match, string(res.Stdout))
	}
}

func TestVersionPattern(t *testing.T) {
	t.Parallel()
	cases := []struct {
		in   string
		want string
	}{
		{"4.20.1", "4.20.1"},
		{" ⛅️ wrangler 4.20.1", "4.20.1"},
		{"4.0.0-beta.3", "4.0.0-beta.3"},
		{"random garbage", ""},
	}
	for _, tc := range cases {
		m := versionPattern.FindStringSubmatch(tc.in)
		got := ""
		if len(m) >= 2 {
			got = m[1]
		}
		if got != tc.want {
			t.Errorf("for %q: want %q, got %q", tc.in, tc.want, got)
		}
	}
}
