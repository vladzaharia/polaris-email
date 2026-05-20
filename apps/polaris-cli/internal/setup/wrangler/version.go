package wrangler

import (
	"context"
	"fmt"
	"regexp"
	"strings"
)

// versionPattern matches `4.X.Y[-suffix]` anywhere in the line. wrangler's
// `--version` output has evolved; modern (v4+) prints just the version,
// older builds prefixed with " ⛅️ wrangler 4.X.Y". A single regex covers
// both.
var versionPattern = regexp.MustCompile(`(\d+\.\d+\.\d+(?:[-+][\w.]+)?)`)

// Detect runs `wrangler --version` and extracts the semver string. The
// returned string is the raw version (e.g. "4.20.1"), or "" if the
// output didn't contain anything parseable.
func Detect(ctx context.Context) (string, error) {
	res, err := Run(ctx, "--version")
	if err != nil {
		// Even on a non-zero exit (some wrangler builds print to stderr
		// and exit 0; some forks exit non-zero on --version), we still
		// try to parse the output we did get.
		if res == nil {
			return "", err
		}
	}
	combined := strings.TrimSpace(string(res.Stdout))
	if combined == "" {
		combined = strings.TrimSpace(string(res.Stderr))
	}
	if combined == "" {
		return "", fmt.Errorf("wrangler --version: empty output")
	}
	matches := versionPattern.FindStringSubmatch(combined)
	if len(matches) < 2 {
		return "", fmt.Errorf("wrangler --version: could not parse %q", combined)
	}
	return matches[1], nil
}
