package preflight

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

// versionRegex matches the first "MAJOR.MINOR.PATCH" triple in a
// version-output string. It's deliberately loose — pnpm prints "9.7.0"
// alone, wrangler v4+ prints just the number, and older wrangler builds
// embed it in "⛅️ wrangler 4.20.1". The same regex covers all three.
var versionRegex = regexp.MustCompile(`(\d+)\.(\d+)\.(\d+)`)

// runTool execs `bin args...` with a context-bound timeout, returning
// trimmed stdout. Returns (output, true) on success and ("", false) on
// any failure (missing binary, non-zero exit, etc.). Used by tool
// probes that only care whether the binary works, not why it failed.
func runTool(ctx context.Context, bin string, args ...string) (string, bool) {
	if _, err := exec.LookPath(bin); err != nil {
		return "", false
	}
	cmd := exec.CommandContext(ctx, bin, args...)
	var out, errBuf bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errBuf
	if err := cmd.Run(); err != nil {
		// Some tools (older wrangler) print --version to stderr. Fall
		// back to stderr if stdout is empty.
		if out.Len() == 0 && errBuf.Len() > 0 {
			return strings.TrimSpace(errBuf.String()), true
		}
		return "", false
	}
	stdout := strings.TrimSpace(out.String())
	if stdout == "" {
		// Tools that print version to stderr only.
		return strings.TrimSpace(errBuf.String()), true
	}
	return stdout, true
}

// parseSemver pulls a MAJOR.MINOR.PATCH triple out of an arbitrary
// version string. Returns (0,0,0,false) on no match.
func parseSemver(s string) (major, minor, patch int, ok bool) {
	m := versionRegex.FindStringSubmatch(s)
	if len(m) < 4 {
		return 0, 0, 0, false
	}
	major, _ = strconv.Atoi(m[1])
	minor, _ = strconv.Atoi(m[2])
	patch, _ = strconv.Atoi(m[3])
	return major, minor, patch, true
}

// CheckPnpm asserts `pnpm --version` reports major >=9. Mirrors the
// shell check `pnpm --version | awk -F. '{exit ($1<9)}'`.
func CheckPnpm() Check {
	return Check{
		Name:        "pnpm >= 9",
		Required:    true,
		Description: "pnpm 9+ is required to install workspace deps",
		Run: func(ctx context.Context) Result {
			out, ok := runTool(ctx, "pnpm", "--version")
			if !ok {
				return fail("pnpm not in PATH", "corepack enable && corepack prepare pnpm@9 --activate")
			}
			major, _, _, parsed := parseSemver(out)
			if !parsed {
				return fail(fmt.Sprintf("could not parse pnpm version %q", out),
					"corepack enable && corepack prepare pnpm@9 --activate")
			}
			if major < 9 {
				return fail(fmt.Sprintf("pnpm %s (need ≥9)", out),
					"corepack enable && corepack prepare pnpm@9 --activate")
			}
			return pass("pnpm " + out)
		},
	}
}

// CheckWranglerInstalled asserts the wrangler binary is reachable.
// Version checking lives in [CheckWranglerVersion] (separate check so
// the install-not-found error doesn't double-count).
func CheckWranglerInstalled() Check {
	return Check{
		Name:        "wrangler installed",
		Required:    true,
		Description: "wrangler 4+ is required for service deploys",
		Run: func(ctx context.Context) Result {
			if _, err := exec.LookPath("wrangler"); err != nil {
				return fail("wrangler not in PATH",
					"pnpm install (wrangler is a workspace dep) or npm i -g wrangler")
			}
			out, ok := runTool(ctx, "wrangler", "--version")
			if !ok {
				return fail("wrangler --version failed",
					"pnpm install (wrangler is a workspace dep) or npm i -g wrangler")
			}
			major, _, _, parsed := parseSemver(out)
			if !parsed {
				return warn(fmt.Sprintf("wrangler version unparsable: %q", out), "")
			}
			if major < 4 {
				return fail(fmt.Sprintf("wrangler %d.x (need ≥4)", major),
					"pnpm i -D wrangler@^4 or npm i -g wrangler@^4")
			}
			return pass(fmt.Sprintf("wrangler %d.x", major))
		},
	}
}

// CheckTool generates a generic "tool is on PATH" check. Used for jq,
// openssl, git, curl, envsubst.
func CheckTool(name, fix string) Check {
	return Check{
		Name:        name + " installed",
		Required:    true,
		Description: name + " is required by bin/* scripts and the deploy flow",
		Run: func(ctx context.Context) Result {
			_ = ctx
			if _, err := exec.LookPath(name); err != nil {
				return fail(name+" not in PATH", fix)
			}
			return pass(name + " in PATH")
		},
	}
}

// CheckJq is jq.
func CheckJq() Check {
	return CheckTool("jq", "brew install jq || apt-get install jq")
}

// CheckOpenSSL is openssl. The Go CLI uses stdlib crypto, but some
// operator scripts and ad-hoc HMAC verification still need the binary.
func CheckOpenSSL() Check {
	return CheckTool("openssl", "brew install openssl || apt-get install openssl")
}

// CheckGit is git — preflight refuses to continue without it because
// `setup infra deploy changed` walks git history.
func CheckGit() Check {
	return CheckTool("git", "install git")
}

// CheckCurl is curl. Used by operator scripts and ad-hoc API probing.
func CheckCurl() Check {
	return CheckTool("curl", "install curl")
}

// CheckEnvsubst is envsubst (from GNU gettext). Kept as a soft
// dependency for operator-side env-substitution scripts.
func CheckEnvsubst() Check {
	return CheckTool("envsubst", "brew install gettext || apt-get install gettext-base")
}

// CheckPolarisMail asserts the CLI binary is on PATH. Required for
// bootstrap step 7 (admin-key minting) where the script invokes
// `polaris-mail auth sign`.
//
// We deliberately check by name (not by path to argv[0]) — the operator
// may have installed it system-wide while running preflight from a
// development tree.
func CheckPolarisMail() Check {
	return Check{
		Name:        "polaris-mail CLI",
		Required:    true,
		Description: "the polaris-mail Go binary must be on PATH (used for HMAC signing during bootstrap)",
		Run: func(ctx context.Context) Result {
			_ = ctx
			if _, err := exec.LookPath("polaris-mail"); err != nil {
				return fail("polaris-mail not in PATH",
					"(cd apps/polaris-cli && go build -o $(go env GOPATH)/bin/polaris-mail ./cmd/polaris-email)")
			}
			return pass("polaris-mail in PATH")
		},
	}
}

// CheckDockerCompose is the opt-in docker compose probe. Gated by the
// shell script's POLARIS_REQUIRE_DOCKER=1 env var; we expose it as a
// non-required check that callers can include in their slice.
func CheckDockerCompose() Check {
	return Check{
		Name:        "docker compose",
		Required:    false,
		Description: "docker compose is required only when running mail-bridge locally",
		Run: func(ctx context.Context) Result {
			if _, err := exec.LookPath("docker"); err != nil {
				return warn("docker not in PATH",
					"install Docker Desktop or docker-compose-plugin")
			}
			cmd := exec.CommandContext(ctx, "docker", "compose", "version")
			if err := cmd.Run(); err != nil {
				return warn("docker compose plugin not available",
					"install Docker Desktop or docker-compose-plugin")
			}
			return pass("docker compose installed")
		},
	}
}
