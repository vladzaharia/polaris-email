package deploy

import (
	"regexp"
)

// Wrangler 4.x prints the deployed version as a line near the end of
// its output:
//
//	"Current Version ID: 9c1b9d3d-1234-4567-89ab-cdef01234567"
//
// 4.50 added a "Deployment ID:" alias on some commands. 4.90+ keeps
// the original format. We accept either spelling, taking the first
// match — wrangler always emits at most one.
//
// The UUID character class includes a-f0-9 plus '-'; we don't anchor
// strictly because subtle formatting differences (trailing whitespace,
// ANSI escapes from the colour layer) can break a tight regex.
var versionIDRE = regexp.MustCompile(`(?:Current Version ID|Deployment ID):\s*([0-9a-fA-F-]{32,40})`)

// ParseVersionID extracts the deployed version UUID from a wrangler
// deploy output. Returns "" if no match — callers may treat that as a
// non-fatal warning (wrangler updates have removed the line in dev
// builds before re-adding it; we don't want to fail deploys over it).
func ParseVersionID(out []byte) string {
	m := versionIDRE.FindSubmatch(out)
	if len(m) < 2 {
		return ""
	}
	return string(m[1])
}
