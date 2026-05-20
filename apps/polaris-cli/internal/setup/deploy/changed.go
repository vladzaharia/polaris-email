package deploy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// ChangedOptions configures the --changed selection.
type ChangedOptions struct {
	// RepoRoot is the absolute path to the polaris-email checkout.
	// Required.
	RepoRoot string
	// BaseSHA is the SHA to diff against. When empty, the runner uses
	// the LastSHAFile fallback chain (file → deployed/main tag → repo
	// root commit).
	BaseSHA string
	// HeadSHA is the upper end of the diff. When empty, defaults to
	// HEAD. Mostly here for tests that want to drive a synthetic
	// (base, head) pair.
	HeadSHA string
	// LastSHAFile is the on-disk record of "the SHA we last deployed
	// to all services". When BaseSHA is empty, we read this file. When
	// the runner finishes a successful --changed run it writes the new
	// HEAD into the same path.
	LastSHAFile string
}

// SelectChanged returns the subset of Services (in canonical order)
// that need redeploying because their code or transitive workspace
// dependencies changed between BaseSHA and HeadSHA.
//
// The reverse-dep graph is built by reading every services/*/package.json
// + apps/*/package.json for entries in Services, looking at their
// dependencies + devDependencies, and recording which workspace
// packages (packages/*/package.json) each one consumes. A change inside
// packages/<foo> ripples to every service that depends on <foo>.
//
// Files that aren't service code AND aren't workspace packages
// (bin/*, Makefile, .env.deploy, etc.) are deliberately ignored — they
// orchestrate the deploy but don't change what's deployed.
//
// Returns the matched services (possibly empty) and the resolved
// HeadSHA so the caller can persist it via WriteLastSHA after a
// successful deploy.
func SelectChanged(ctx context.Context, opts ChangedOptions) ([]Service, string, error) {
	if opts.RepoRoot == "" {
		return nil, "", errors.New("deploy.SelectChanged: RepoRoot required")
	}
	base, err := resolveBaseSHA(ctx, opts)
	if err != nil {
		return nil, "", err
	}
	head := opts.HeadSHA
	if head == "" {
		head, err = gitRevParse(ctx, opts.RepoRoot, "HEAD")
		if err != nil {
			return nil, "", fmt.Errorf("git rev-parse HEAD: %w", err)
		}
	}
	if base == head {
		// No-op: HEAD is already deployed.
		return nil, head, nil
	}

	files, err := gitDiffNames(ctx, opts.RepoRoot, base, head)
	if err != nil {
		return nil, head, fmt.Errorf("git diff: %w", err)
	}
	if len(files) == 0 {
		return nil, head, nil
	}

	revDeps, err := buildReverseDepGraph(opts.RepoRoot)
	if err != nil {
		return nil, head, fmt.Errorf("reverse-dep graph: %w", err)
	}

	matched := map[string]bool{}
	for _, f := range files {
		classify(f, revDeps, matched)
	}

	// Iterate Services in canonical order so the deploy order is the
	// same whether we selected one or all.
	out := make([]Service, 0, len(matched))
	for _, svc := range Services {
		if matched[svc.Name] {
			out = append(out, svc)
		}
	}
	return out, head, nil
}

// classify routes one changed file path into the matched-services set:
//
//   - services/<svc>/...    → matches <svc>
//   - apps/<app>/...        → matches <app> when <app> is in Services
//   - packages/<pkg>/...    → matches every Service whose package.json
//     lists @polaris-email/<pkg> in deps or devDeps (via revDeps)
//   - bin/*, Makefile, .env.deploy → ignored
//   - everything else       → ignored
func classify(path string, revDeps map[string][]string, matched map[string]bool) {
	switch {
	case strings.HasPrefix(path, "services/"):
		// services/<svc>/<rest>
		rest := strings.TrimPrefix(path, "services/")
		seg := strings.SplitN(rest, "/", 2)
		if len(seg) > 0 && seg[0] != "" {
			if _, ok := ByName(seg[0]); ok {
				matched[seg[0]] = true
			}
		}
	case strings.HasPrefix(path, "apps/"):
		rest := strings.TrimPrefix(path, "apps/")
		seg := strings.SplitN(rest, "/", 2)
		if len(seg) > 0 && seg[0] != "" {
			if _, ok := ByName(seg[0]); ok {
				matched[seg[0]] = true
			}
		}
	case strings.HasPrefix(path, "packages/"):
		rest := strings.TrimPrefix(path, "packages/")
		seg := strings.SplitN(rest, "/", 2)
		if len(seg) == 0 || seg[0] == "" {
			return
		}
		pkgDir := seg[0]
		// Look up the workspace package's npm-name from revDeps; if
		// it's keyed by directory we hit directly, if by npm-name we
		// resolved via the map.
		for _, consumer := range revDeps[pkgDir] {
			matched[consumer] = true
		}
	default:
		// bin/*, Makefile, .env.deploy, top-level config, etc.
		return
	}
}

// resolveBaseSHA picks the SHA to diff against. Order:
//  1. opts.BaseSHA (explicit override).
//  2. contents of opts.LastSHAFile.
//  3. git rev-parse deployed/main (if the tag exists).
//  4. repo root commit (`git rev-list --max-parents=0 HEAD | head -1`).
//
// Returning an empty string is an error: every other phase needs SOME
// SHA to diff against.
func resolveBaseSHA(ctx context.Context, opts ChangedOptions) (string, error) {
	if opts.BaseSHA != "" {
		return opts.BaseSHA, nil
	}
	if opts.LastSHAFile != "" {
		if data, err := os.ReadFile(opts.LastSHAFile); err == nil {
			s := strings.TrimSpace(string(data))
			if s != "" {
				return s, nil
			}
		}
	}
	if sha, err := gitRevParse(ctx, opts.RepoRoot, "deployed/main"); err == nil && sha != "" {
		return sha, nil
	}
	// Repo-root commit fallback.
	cmd := exec.CommandContext(ctx, "git", "rev-list", "--max-parents=0", "HEAD")
	cmd.Dir = opts.RepoRoot
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("git rev-list --max-parents=0: %w", err)
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			return line, nil
		}
	}
	return "", errors.New("no SHA to diff against (empty repo?)")
}

// gitRevParse wraps `git rev-parse <ref>` from a given working dir.
func gitRevParse(ctx context.Context, dir, ref string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", "rev-parse", ref)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// gitDiffNames wraps `git diff --name-only base..head`.
func gitDiffNames(ctx context.Context, dir, base, head string) ([]string, error) {
	cmd := exec.CommandContext(ctx, "git", "diff", "--name-only", base+".."+head)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	var files []string
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			files = append(files, line)
		}
	}
	return files, nil
}

// pkgJSON is the subset of a package.json we care about for
// dependency-graph construction.
type pkgJSON struct {
	Name            string            `json:"name"`
	Dependencies    map[string]string `json:"dependencies"`
	DevDependencies map[string]string `json:"devDependencies"`
}

// buildReverseDepGraph reads every packages/*/package.json + every
// service+app package.json under repoRoot and returns a map:
//
//	package-dir → []service-name-that-depends-on-it
//
// We key by package directory (e.g. "policy-engine") rather than by
// npm name (e.g. "@polaris-email/policy-engine") because the changed-
// file path arrives as packages/<dir>/* and the directory is what we
// need to resolve.
//
// Internally we still build the name→dir lookup table because services
// list npm names in their dependencies block.
func buildReverseDepGraph(repoRoot string) (map[string][]string, error) {
	pkgsDir := filepath.Join(repoRoot, "packages")
	entries, err := os.ReadDir(pkgsDir)
	if err != nil {
		// No packages/ dir is unexpected but not fatal — return an
		// empty graph and let the caller proceed (every change will
		// only match services + apps directly).
		if errors.Is(err, os.ErrNotExist) {
			return map[string][]string{}, nil
		}
		return nil, err
	}

	// npm-name → package directory.
	nameToDir := map[string]string{}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		pj := filepath.Join(pkgsDir, e.Name(), "package.json")
		data, err := os.ReadFile(pj)
		if err != nil {
			continue // ignore packages without a package.json (sdk-go is one)
		}
		var p pkgJSON
		if err := json.Unmarshal(data, &p); err != nil {
			continue
		}
		if p.Name != "" {
			nameToDir[p.Name] = e.Name()
		}
	}

	revDeps := map[string][]string{}
	for _, svc := range Services {
		pj := filepath.Join(repoRoot, svc.Path, "package.json")
		data, err := os.ReadFile(pj)
		if err != nil {
			continue
		}
		var p pkgJSON
		if err := json.Unmarshal(data, &p); err != nil {
			continue
		}
		for dep := range p.Dependencies {
			if dir, ok := nameToDir[dep]; ok {
				revDeps[dir] = append(revDeps[dir], svc.Name)
			}
		}
		for dep := range p.DevDependencies {
			if dir, ok := nameToDir[dep]; ok {
				revDeps[dir] = append(revDeps[dir], svc.Name)
			}
		}
	}
	return revDeps, nil
}

// WriteLastSHA persists the head SHA so the next --changed run knows
// the starting point. Mode 0644 — this file is not secret.
func WriteLastSHA(path, sha string) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(sha), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
