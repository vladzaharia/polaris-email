package preflight

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// trackedServices is the canonical list of polaris-email service
// directories that must be git-tracked. Mirrors POLARIS_SERVICES from
// bin/_lib.sh — keep them in sync.
//
// Order matters for human-readable output (api first, panel last).
var trackedServices = []serviceDir{
	{Path: "services/api", Anchor: "wrangler.jsonc"},
	{Path: "services/out", Anchor: "wrangler.jsonc"},
	{Path: "services/in", Anchor: "wrangler.jsonc"},
	{Path: "apps/panel", Anchor: "wrangler.jsonc"},
}

// serviceDir is a directory we expect to find tracked in git, paired
// with a sentinel file (typically wrangler.jsonc) whose presence in
// `git ls-files` confirms the directory is fully tracked.
type serviceDir struct {
	Path   string
	Anchor string
}

// CheckGitTrackedServices catches the "global ~/.gitignore swallows
// services/out" class of bug. The shell script does the same probe; if
// you skip either implementation the operator can ship a deploy that
// silently misses a service.
//
// repoRoot is the absolute path to the polaris-email repo root. Pass
// "" to use the current working directory.
func CheckGitTrackedServices(repoRoot string) Check {
	return Check{
		Name:        "service dirs git-tracked",
		Required:    true,
		Description: "every services/* and apps/panel directory must be checked into git",
		Run: func(ctx context.Context) Result {
			if _, err := exec.LookPath("git"); err != nil {
				// Already reported by CheckGit — degrade to warn here to
				// avoid double-counting the fail.
				return warn("git not in PATH (covered by separate check)", "")
			}
			root := repoRoot
			if root == "" {
				root = "."
			}
			// `git rev-parse --git-dir` confirms we're inside a repo.
			rev := exec.CommandContext(ctx, "git", "-C", root, "rev-parse", "--git-dir")
			if err := rev.Run(); err != nil {
				// Not in a git checkout — the shell script silently skips
				// the check in that case; we mirror that with a warn so
				// the operator sees it instead of a confusing pass.
				return warn("not inside a git repository", "")
			}

			var missing []string
			for _, svc := range trackedServices {
				anchor := filepath.Join(svc.Path, svc.Anchor)
				// `git ls-files --error-unmatch` exits non-zero if the
				// path isn't tracked. We can't check the filesystem
				// alone — the operator may have a global gitignore that
				// makes the directory exist on disk but not in git.
				lsCmd := exec.CommandContext(ctx, "git", "-C", root,
					"ls-files", "--error-unmatch", anchor)
				var stderr bytes.Buffer
				lsCmd.Stderr = &stderr
				if err := lsCmd.Run(); err != nil {
					// Only report missing if the directory actually exists
					// on disk — a missing-on-disk service directory is a
					// repo-layout problem out of scope for preflight.
					if dirExists(filepath.Join(root, svc.Path)) {
						missing = append(missing, svc.Path)
					}
				}
			}

			if len(missing) > 0 {
				return fail(
					fmt.Sprintf("untracked service dirs: %s", strings.Join(missing, ", ")),
					"check `git check-ignore -v <path>` (often a global ~/.gitignore rule); "+
						"add `!<path>/` and `!<path>/**` to the repo .gitignore, then `git add` the directory")
			}
			return pass("all service directories tracked in git")
		},
	}
}

// dirExists reports whether the path is an existing directory. A path
// that exists as a non-directory (regular file, symlink to a file)
// returns false — we only care about real service directories.
func dirExists(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	return info.IsDir()
}
