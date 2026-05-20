package deploy

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// gitRepo bootstraps a temp git repo with the packages/* + services/*
// + apps/* layout the production runner expects. Returns the repo
// root.
//
// We construct three real commits so the diff machinery has something
// to chew on. The fixture deliberately mirrors the polaris-email
// workspace shape: api consumes @polaris-email/hmac; panel consumes
// @polaris-email/sdk-node.
func gitRepo(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = root
		// Quieten git config prompts on CI machines without a global config.
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=test", "GIT_AUTHOR_EMAIL=test@example.com",
			"GIT_COMMITTER_NAME=test", "GIT_COMMITTER_EMAIL=test@example.com",
		)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}

	// Initial commit with the full workspace layout.
	run("init", "-q", "-b", "main")
	mustWrite := func(rel string, content string) {
		full := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", rel, err)
		}
	}
	mustWrite("packages/hmac/package.json", `{"name": "@polaris-email/hmac", "version": "0.1.0"}`)
	mustWrite("packages/sdk-node/package.json", `{"name": "@polaris-email/sdk-node", "version": "0.1.0"}`)
	mustWrite("packages/unused/package.json", `{"name": "@polaris-email/unused", "version": "0.1.0"}`)
	mustWrite("services/api/package.json", `{"name": "@polaris-email/api", "dependencies": {"@polaris-email/hmac": "*"}}`)
	mustWrite("services/out/package.json", `{"name": "@polaris-email/out"}`)
	mustWrite("services/in/package.json", `{"name": "@polaris-email/in"}`)
	mustWrite("apps/panel/package.json", `{"name": "@polaris-email/panel", "dependencies": {"@polaris-email/sdk-node": "*"}}`)
	mustWrite("apps/docs/package.json", `{"name": "@polaris-email/docs"}`)
	mustWrite("apps/cli-installer/package.json", `{"name": "@polaris-email/cli-installer"}`)
	mustWrite("bin/dev.sh", "# orchestration\n")
	mustWrite("Makefile", "preflight:\n\techo ok\n")
	run("add", ".")
	run("commit", "-q", "-m", "initial")
	return root
}

func gitCommit(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for rel, content := range files {
		full := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = root
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=test", "GIT_AUTHOR_EMAIL=test@example.com",
			"GIT_COMMITTER_NAME=test", "GIT_COMMITTER_EMAIL=test@example.com",
		)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("add", ".")
	run("commit", "-q", "-m", "test commit")
}

func gitHead(t *testing.T, root string) string {
	t.Helper()
	cmd := exec.Command("git", "rev-parse", "HEAD")
	cmd.Dir = root
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("rev-parse: %v", err)
	}
	return strings.TrimSpace(string(out))
}

func TestSelectChanged_ServiceChangeMatchesOnlyThatService(t *testing.T) {
	t.Parallel()
	root := gitRepo(t)
	base := gitHead(t, root)
	gitCommit(t, root, map[string]string{"services/api/src/index.ts": "// new code\n"})
	head := gitHead(t, root)

	svcs, _, err := SelectChanged(context.Background(), ChangedOptions{
		RepoRoot: root, BaseSHA: base, HeadSHA: head,
	})
	if err != nil {
		t.Fatalf("SelectChanged: %v", err)
	}
	if len(svcs) != 1 || svcs[0].Name != "api" {
		t.Errorf("want only [api], got %v", svcs)
	}
}

func TestSelectChanged_PackageChangeRipplesToConsumers(t *testing.T) {
	t.Parallel()
	root := gitRepo(t)
	base := gitHead(t, root)
	gitCommit(t, root, map[string]string{"packages/hmac/src/index.ts": "// hmac update\n"})
	head := gitHead(t, root)

	svcs, _, err := SelectChanged(context.Background(), ChangedOptions{
		RepoRoot: root, BaseSHA: base, HeadSHA: head,
	})
	if err != nil {
		t.Fatalf("SelectChanged: %v", err)
	}
	// hmac is consumed only by api in the fixture.
	if len(svcs) != 1 || svcs[0].Name != "api" {
		t.Errorf("want only [api], got %v", svcs)
	}
}

func TestSelectChanged_UnusedPackageHasNoConsumers(t *testing.T) {
	t.Parallel()
	root := gitRepo(t)
	base := gitHead(t, root)
	gitCommit(t, root, map[string]string{"packages/unused/src/index.ts": "// nobody uses me\n"})
	head := gitHead(t, root)

	svcs, _, err := SelectChanged(context.Background(), ChangedOptions{
		RepoRoot: root, BaseSHA: base, HeadSHA: head,
	})
	if err != nil {
		t.Fatalf("SelectChanged: %v", err)
	}
	if len(svcs) != 0 {
		t.Errorf("orphan package should not match anything, got %v", svcs)
	}
}

func TestSelectChanged_BinAndMakefileIgnored(t *testing.T) {
	t.Parallel()
	root := gitRepo(t)
	base := gitHead(t, root)
	gitCommit(t, root, map[string]string{
		"bin/dev.sh": "# orchestration tweak\n",
		"Makefile":    "preflight:\n\techo new\n",
	})
	head := gitHead(t, root)

	svcs, _, err := SelectChanged(context.Background(), ChangedOptions{
		RepoRoot: root, BaseSHA: base, HeadSHA: head,
	})
	if err != nil {
		t.Fatalf("SelectChanged: %v", err)
	}
	if len(svcs) != 0 {
		t.Errorf("bin/* + Makefile must be ignored, got %v", svcs)
	}
}

func TestSelectChanged_AppsPanelMapsToPanel(t *testing.T) {
	t.Parallel()
	root := gitRepo(t)
	base := gitHead(t, root)
	gitCommit(t, root, map[string]string{"apps/panel/src/app.tsx": "// new ui\n"})
	head := gitHead(t, root)

	svcs, _, err := SelectChanged(context.Background(), ChangedOptions{
		RepoRoot: root, BaseSHA: base, HeadSHA: head,
	})
	if err != nil {
		t.Fatalf("SelectChanged: %v", err)
	}
	if len(svcs) != 1 || svcs[0].Name != "panel" {
		t.Errorf("want only [panel], got %v", svcs)
	}
}

func TestSelectChanged_MultipleServicesInCanonicalOrder(t *testing.T) {
	t.Parallel()
	root := gitRepo(t)
	base := gitHead(t, root)
	gitCommit(t, root, map[string]string{
		"apps/panel/src/app.tsx":   "// ui\n",
		"services/api/src/x.ts":    "// api change\n",
		"services/in/src/index.ts": "// in change\n",
	})
	head := gitHead(t, root)

	svcs, _, err := SelectChanged(context.Background(), ChangedOptions{
		RepoRoot: root, BaseSHA: base, HeadSHA: head,
	})
	if err != nil {
		t.Fatalf("SelectChanged: %v", err)
	}
	// Canonical order: api → in → panel (out, docs, cli-installer skipped).
	names := make([]string, len(svcs))
	for i, s := range svcs {
		names[i] = s.Name
	}
	want := []string{"api", "in", "panel"}
	if len(names) != len(want) {
		t.Fatalf("want %v, got %v", want, names)
	}
	for i := range want {
		if names[i] != want[i] {
			t.Errorf("order[%d]: want %s, got %s", i, want[i], names[i])
		}
	}
}

func TestSelectChanged_HeadEqualsBaseIsNoop(t *testing.T) {
	t.Parallel()
	root := gitRepo(t)
	head := gitHead(t, root)
	svcs, gotHead, err := SelectChanged(context.Background(), ChangedOptions{
		RepoRoot: root, BaseSHA: head, HeadSHA: head,
	})
	if err != nil {
		t.Fatalf("SelectChanged: %v", err)
	}
	if len(svcs) != 0 {
		t.Errorf("HEAD==base: want empty, got %v", svcs)
	}
	if gotHead != head {
		t.Errorf("returned head: want %s, got %s", head, gotHead)
	}
}

func TestSelectChanged_LastSHAFallback(t *testing.T) {
	t.Parallel()
	root := gitRepo(t)
	base := gitHead(t, root)
	lastSHA := filepath.Join(t.TempDir(), "last-sha")
	if err := os.WriteFile(lastSHA, []byte(base+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitCommit(t, root, map[string]string{"services/api/src/x.ts": "// change\n"})

	svcs, _, err := SelectChanged(context.Background(), ChangedOptions{
		RepoRoot: root, LastSHAFile: lastSHA,
	})
	if err != nil {
		t.Fatalf("SelectChanged: %v", err)
	}
	if len(svcs) != 1 || svcs[0].Name != "api" {
		t.Errorf("want only [api] via LastSHAFile, got %v", svcs)
	}
}

func TestWriteLastSHA_AtomicWrite(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "last-sha")
	if err := WriteLastSHA(path, "abc123"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "abc123" {
		t.Errorf("contents: want abc123, got %q", string(data))
	}
}
