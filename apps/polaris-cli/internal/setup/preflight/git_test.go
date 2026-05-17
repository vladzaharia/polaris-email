package preflight

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// gitRepo creates a fresh git repo in t.TempDir() and returns the
// directory. Files staged via addFile() are committed before the
// returned path is used.
func gitRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not in PATH")
	}
	dir := t.TempDir()
	run := func(args ...string) {
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		// Avoid the operator's global git config leaking into the test.
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=test", "GIT_AUTHOR_EMAIL=test@example.com",
			"GIT_COMMITTER_NAME=test", "GIT_COMMITTER_EMAIL=test@example.com",
		)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init", "--initial-branch=main")
	run("config", "user.email", "test@example.com")
	run("config", "user.name", "test")
	// Disable any global core.excludesFile (operators often have ~/.gitignore
	// ignoring `out/` or `dist/`, which clashes with our services/out path).
	run("config", "core.excludesFile", "/dev/null")
	return dir
}

func writeAndCommit(t *testing.T, repo, rel, content string) {
	t.Helper()
	full := filepath.Join(repo, rel)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	cmd := exec.Command("git", "-C", repo, "add", rel)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git add %s: %v\n%s", rel, err, out)
	}
	cmd = exec.Command("git", "-C", repo, "commit", "-m", "add "+rel)
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=test", "GIT_AUTHOR_EMAIL=test@example.com",
		"GIT_COMMITTER_NAME=test", "GIT_COMMITTER_EMAIL=test@example.com",
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git commit: %v\n%s", err, out)
	}
}

func TestCheckGitTrackedServices_AllTracked(t *testing.T) {
	t.Parallel()
	repo := gitRepo(t)
	for _, svc := range trackedServices {
		writeAndCommit(t, repo, filepath.Join(svc.Path, svc.Anchor), "{}")
	}
	res := CheckGitTrackedServices(repo).Run(context.Background())
	if res.Status != StatusPass {
		t.Errorf("all-tracked should pass, got %+v", res)
	}
}

func TestCheckGitTrackedServices_DetectsUntracked(t *testing.T) {
	t.Parallel()
	repo := gitRepo(t)
	// Commit only api+in+panel; services/out is on disk but ignored.
	for _, p := range []string{"services/api/wrangler.jsonc", "services/in/wrangler.jsonc", "apps/panel/wrangler.jsonc"} {
		writeAndCommit(t, repo, p, "{}")
	}
	// Make services/out exist on disk but untracked.
	if err := os.MkdirAll(filepath.Join(repo, "services", "out"), 0o755); err != nil {
		t.Fatalf("mkdir services/out: %v", err)
	}
	if err := os.WriteFile(filepath.Join(repo, "services", "out", "wrangler.jsonc"), []byte("{}"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	res := CheckGitTrackedServices(repo).Run(context.Background())
	if res.Status != StatusFail {
		t.Errorf("untracked services/out should fail, got %+v", res)
	}
}

func TestCheckGitTrackedServices_OutsideRepoWarns(t *testing.T) {
	t.Parallel()
	dir := t.TempDir() // not a git repo
	res := CheckGitTrackedServices(dir).Run(context.Background())
	if res.Status != StatusWarn {
		t.Errorf("outside-repo should warn, got %+v", res)
	}
}
