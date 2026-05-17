package preflight

import (
	"context"
	"os/exec"
)

// CheckWranglerLoggedIn verifies `wrangler whoami` succeeds. The shell
// script delegates to wrangler entirely; we mirror that — wrangler's
// own credentials cache + login flow is the source of truth.
//
// Failure modes we deliberately treat as a single FAIL line: missing
// binary, expired OAuth token, network unreachable. They all surface
// the same remediation (`wrangler login`).
func CheckWranglerLoggedIn() Check {
	return Check{
		Name:        "wrangler logged in",
		Required:    true,
		Description: "the local wrangler session must be authenticated",
		Run: func(ctx context.Context) Result {
			if _, err := exec.LookPath("wrangler"); err != nil {
				return fail("wrangler not in PATH", "wrangler login")
			}
			cmd := exec.CommandContext(ctx, "wrangler", "whoami")
			if err := cmd.Run(); err != nil {
				return fail("wrangler whoami failed", "wrangler login")
			}
			return pass("authenticated")
		},
	}
}
