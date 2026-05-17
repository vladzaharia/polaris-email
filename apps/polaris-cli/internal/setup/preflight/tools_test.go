package preflight

import (
	"context"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestParseSemver(t *testing.T) {
	t.Parallel()
	cases := []struct {
		in             string
		wantOK         bool
		major          int
		minor          int
		patch          int
	}{
		{"9.7.0", true, 9, 7, 0},
		{"pnpm 9.7.0", true, 9, 7, 0},
		{" ⛅️ wrangler 4.20.1", true, 4, 20, 1},
		{"random garbage", false, 0, 0, 0},
		{"", false, 0, 0, 0},
	}
	for _, c := range cases {
		major, minor, patch, ok := parseSemver(c.in)
		if ok != c.wantOK || major != c.major || minor != c.minor || patch != c.patch {
			t.Errorf("parseSemver(%q) = (%d.%d.%d, %v), want (%d.%d.%d, %v)",
				c.in, major, minor, patch, ok, c.major, c.minor, c.patch, c.wantOK)
		}
	}
}

func TestCheckTool_MissingBinary(t *testing.T) {
	t.Parallel()
	c := CheckTool("polaris-no-such-tool-91d3", "install it")
	res := c.Run(context.Background())
	if res.Status != StatusFail {
		t.Errorf("missing tool should fail, got %v", res)
	}
	if !strings.Contains(res.Detail, "polaris-no-such-tool") {
		t.Errorf("detail should name the tool, got %q", res.Detail)
	}
}

// fakeBinDir returns the directory containing testdata stub scripts.
// We reuse the wrangler testdata when needed; tools tests put their
// stubs alongside.
func fakeBinDir(t *testing.T) string {
	t.Helper()
	_, this, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not resolve test file path")
	}
	return filepath.Join(filepath.Dir(this), "testdata")
}

func TestCheckPnpm_StubbedNotInPath(t *testing.T) {
	// Cannot run in parallel because t.Setenv mutates process env.
	t.Setenv("PATH", fakeBinDir(t))
	c := CheckPnpm()
	res := c.Run(context.Background())
	if res.Status != StatusFail {
		t.Errorf("pnpm-not-found should be fail, got %+v", res)
	}
}

func TestCheckPolarisEmail_StubbedNotInPath(t *testing.T) {
	// Cannot run in parallel because t.Setenv mutates process env.
	t.Setenv("PATH", fakeBinDir(t))
	c := CheckPolarisEmail()
	res := c.Run(context.Background())
	if res.Status != StatusFail {
		t.Errorf("polaris-email-not-found should be fail, got %+v", res)
	}
}
