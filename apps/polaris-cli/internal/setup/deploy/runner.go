package deploy

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/state"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/wrangler"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/wranglercfg"
)

// Options gates the runner's behaviour. All fields are optional; sensible
// defaults apply.
type Options struct {
	// RepoRoot is the absolute path to the polaris-email repository
	// root. Empty defaults to os.Getwd(). All Service.Path values are
	// resolved relative to this.
	RepoRoot string
	// NoBuild skips the `pnpm run build:client` step even for services
	// that flag IsClientBuild=true. Used by re-deploys that know the
	// bundle is current.
	NoBuild bool
	// SkipMerge forces the runner to deploy with the plain
	// wrangler.jsonc (no local overlay merge). Used by services that
	// don't have a wrangler.local.jsonc — wrangler picks up env vars
	// from the shell instead.
	SkipMerge bool
	// Force re-deploys even when state already records the current SHA.
	// Currently a no-op (we always re-deploy when invoked) but kept as
	// a knob for PR 13's rollback flow.
	Force bool
	// Reporter receives per-service progress events. nil → no
	// reporting.
	Reporter Reporter
}

// Reporter is the deploy-side counterpart to provision.Reporter. The
// runner emits events as services move from "queued" → "building" →
// "deploying" → ("done" | "failed").
type Reporter interface {
	Start(total int)
	Step(service, phase string)
	StepDone(service string, versionID string, err error)
	Done()
}

// Deploy executes the deploys for `svcs` in order. Each service:
//
//  1. (optional) `pnpm --filter <pkg> run build:client` if IsClientBuild.
//  2. Renders wrangler.local.jsonc — already handled by `setup infra
//     render` and not re-done here; the operator runs render first.
//  3. Merges wrangler.jsonc + wrangler.local.jsonc into a transient
//     .wrangler.merged.json.
//  4. Runs `wrangler deploy --config .wrangler.merged.json` from the
//     service directory.
//  5. Parses the version ID and records into state.Doc.Deploys[name].
//
// Failures on one service abort the run — the dependency order
// (api→out→in→...) means a failed api leaves the cluster broken
// already, so charging ahead would only deploy on top of a broken
// api.
func Deploy(ctx context.Context, svcs []Service, store *state.Store, opts Options) error {
	if len(svcs) == 0 {
		return nil
	}
	reporter := opts.Reporter
	if reporter == nil {
		reporter = nopReporter{}
	}
	reporter.Start(len(svcs))
	defer reporter.Done()

	root := opts.RepoRoot
	if root == "" {
		wd, err := os.Getwd()
		if err != nil {
			return fmt.Errorf("deploy: cwd: %w", err)
		}
		root = wd
	}

	for _, svc := range svcs {
		if err := ctx.Err(); err != nil {
			return err
		}
		if svc.IsClientBuild && !opts.NoBuild {
			reporter.Step(svc.Name, "building")
			if err := buildClient(ctx, root, svc); err != nil {
				reporter.StepDone(svc.Name, "", err)
				return fmt.Errorf("deploy %s: %w", svc.Name, err)
			}
		}
		reporter.Step(svc.Name, "deploying")
		vid, err := deployOne(ctx, root, svc, opts.SkipMerge)
		reporter.StepDone(svc.Name, vid, err)
		if err != nil {
			return fmt.Errorf("deploy %s: %w", svc.Name, err)
		}
		if store != nil {
			if err := recordDeploy(store, svc.Name, vid); err != nil {
				return fmt.Errorf("deploy %s: record: %w", svc.Name, err)
			}
		}
	}
	return nil
}

// buildClient runs `pnpm --filter <pkg> run build:client` for one
// service. We use the service's package.json name when available; the
// short Name works as a fallback because pnpm accepts the directory
// path too.
func buildClient(ctx context.Context, root string, svc Service) error {
	dir := filepath.Join(root, svc.Path)
	// `pnpm --filter ./relative/path` is the most reliable form across
	// pnpm major versions — it doesn't require knowing the package's
	// scoped name (e.g. @polaris-email/panel) inside this package.
	cmd := exec.CommandContext(ctx, "pnpm", "--filter", "./"+svc.Path, "run", "build:client")
	cmd.Dir = root
	cmd.Stdout = os.Stderr // build chatter goes to stderr; stdout is reserved for structured output
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("build:client failed in %s: %w", dir, err)
	}
	return nil
}

// deployOne shells out to `wrangler deploy` after merging the per-service
// wrangler configs. Returns the parsed version ID (empty on parse
// failure — see ParseVersionID).
func deployOne(ctx context.Context, root string, svc Service, skipMerge bool) (string, error) {
	dir := filepath.Join(root, svc.Path)
	args := []string{"deploy"}
	mergedPath := ""

	if !skipMerge {
		base := filepath.Join(dir, "wrangler.jsonc")
		overlay := filepath.Join(dir, "wrangler.local.jsonc")
		if _, err := os.Stat(base); err == nil {
			if _, err := os.Stat(overlay); err == nil {
				mergedPath = filepath.Join(dir, ".wrangler.merged.json")
				if err := mergeConfigs(base, overlay, mergedPath); err != nil {
					return "", fmt.Errorf("merge configs: %w", err)
				}
				defer func() { _ = os.Remove(mergedPath) }()
				args = append(args, "--config", ".wrangler.merged.json")
			}
		}
	}

	// We have to cd into the service directory so wrangler picks up the
	// right pwd-relative bindings (Vite assets, etc.). The exec wrapper
	// doesn't take a Dir, so use exec.CommandContext directly.
	cmd := exec.CommandContext(ctx, wrangler.Binary, args...)
	cmd.Dir = dir
	// Stream stderr live for operator visibility; capture stdout for
	// version-id parsing.
	cmd.Stderr = os.Stderr
	out, err := cmd.Output()
	if err != nil {
		// exec wraps the exit code; include the service name and the
		// merged-path so operators can re-run the same wrangler call
		// manually if needed.
		return "", fmt.Errorf("wrangler deploy: %w", err)
	}
	return ParseVersionID(out), nil
}

// mergeConfigs reads base + overlay, runs wranglercfg.Merge, writes to
// dst atomically (temp+rename so a kill -9 mid-write can't leave a
// half-merged file that the next wrangler invocation tries to parse).
func mergeConfigs(base, overlay, dst string) error {
	baseBytes, err := os.ReadFile(base)
	if err != nil {
		return fmt.Errorf("read base: %w", err)
	}
	overlayBytes, err := os.ReadFile(overlay)
	if err != nil {
		return fmt.Errorf("read overlay: %w", err)
	}
	merged, err := wranglercfg.Merge(baseBytes, overlayBytes)
	if err != nil {
		return fmt.Errorf("merge: %w", err)
	}
	tmp := dst + ".tmp"
	if err := os.WriteFile(tmp, merged, 0o644); err != nil {
		return fmt.Errorf("write temp: %w", err)
	}
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("rename: %w", err)
	}
	return nil
}

// recordDeploy stamps the deploy into state.Doc.Deploys.
func recordDeploy(store *state.Store, svcName, vid string) error {
	unlock, err := store.Lock(true)
	if err != nil {
		return err
	}
	defer func() { _ = unlock() }()

	doc, err := store.Read()
	if err != nil {
		return err
	}
	if doc.Deploys == nil {
		doc.Deploys = map[string]state.DeployRecord{}
	}
	sha := gitHEAD()
	doc.Deploys[svcName] = state.DeployRecord{
		VersionID: vid,
		SHA:       sha,
		At:        time.Now().UTC(),
	}
	return store.Write(doc)
}

// gitHEAD returns the short SHA of HEAD, or "unknown" if the call
// fails (no git, detached worktree, etc).
func gitHEAD() string {
	cmd := exec.Command("git", "rev-parse", "HEAD")
	out, err := cmd.Output()
	if err != nil {
		return "unknown"
	}
	return strings.TrimSpace(string(out))
}

// nopReporter is the default when no reporter is wired.
type nopReporter struct{}

func (nopReporter) Start(int)                        {}
func (nopReporter) Step(string, string)              {}
func (nopReporter) StepDone(string, string, error)   {}
func (nopReporter) Done()                            {}

// PlainReporter writes one line per service phase to W. Used in
// --non-interactive mode and CI; the TUI reporter (cmd/) is a Bubble
// Tea program.
type PlainReporter struct {
	W       io.Writer
	current int
	total   int
}

// NewPlainReporter constructs a PlainReporter writing to w.
func NewPlainReporter(w io.Writer) *PlainReporter { return &PlainReporter{W: w} }

// Start records the total step count for the "1/N" prefix.
func (p *PlainReporter) Start(total int) {
	p.total = total
	p.current = 0
	if p.W != nil && total > 0 {
		fmt.Fprintf(p.W, "deploy: %d service(s)\n", total)
	}
}

// Step prints the in-flight phase line.
func (p *PlainReporter) Step(service, phase string) {
	if p.W == nil {
		return
	}
	fmt.Fprintf(p.W, "  [%d/%d] %s: %s\n", p.current+1, p.total, service, phase)
}

// StepDone advances the counter and prints the result.
func (p *PlainReporter) StepDone(service, versionID string, err error) {
	p.current++
	if p.W == nil {
		return
	}
	if err != nil {
		fmt.Fprintf(p.W, "  [%d/%d] %s: FAILED: %v\n", p.current, p.total, service, err)
		return
	}
	if versionID != "" {
		fmt.Fprintf(p.W, "  [%d/%d] %s: done (version=%s)\n", p.current, p.total, service, versionID)
		return
	}
	fmt.Fprintf(p.W, "  [%d/%d] %s: done\n", p.current, p.total, service)
}

// Done emits a closing line.
func (p *PlainReporter) Done() {
	if p.W == nil || p.total == 0 {
		return
	}
	fmt.Fprintln(p.W, "deploy: complete")
}
