package cmd

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/state"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/wranglercfg"
)

// defaultEnvDeployPath is the conventional repo-root-relative
// .env.deploy location.
const defaultEnvDeployPath = ".env.deploy"

// renderableServices is the canonical list of Workers whose
// `wrangler.local.template.jsonc` this command knows how to render.
var renderableServices = []renderableService{
	{Name: "api", Dir: "services/api"},
	{Name: "in", Dir: "services/in"},
	{Name: "out", Dir: "services/out"},
	{Name: "panel", Dir: "apps/panel"},
	{Name: "docs", Dir: "apps/docs"},
	{Name: "cli-installer", Dir: "apps/cli-installer"},
}

type renderableService struct {
	Name string
	Dir  string
}

// newInfraRenderCmd builds the `setup infra render` leaf. The bare form
// reads .deploy-state.json + .env.deploy, validates the inputs, and
// writes every service's `wrangler.local.template.jsonc` →
// `wrangler.local.jsonc`. Two side-modes are wired in via flags:
//
//   - `--dry-run` prints the rendered bytes to stdout (or to --service's
//     output) instead of writing. Useful for diffing.
//   - `--merge <base> <overlay>` parses two JSONC files, deep-merges
//     them, and emits the result. The deploy phase uses the same merger
//     to combine wrangler.jsonc + wrangler.local.jsonc.
func newInfraRenderCmd() *cobra.Command {
	var (
		statePath  string
		envPath    string
		serviceArg string
		dryRun     bool
		mergeBase  string
		mergeOver  string
		outputPath string
	)
	c := &cobra.Command{
		Use:   "render",
		Short: "Render services/*/wrangler.local.jsonc from templates + .deploy-state.json + .env.deploy",
		Long: "Render every Worker's wrangler.local.jsonc by expanding its\n" +
			"wrangler.local.template.jsonc against the typed RenderInputs view\n" +
			"of .deploy-state.json + .env.deploy.\n" +
			"\n" +
			"Templates use Go text/template syntax (`{{ .Account.ID }}`,\n" +
			"`{{ .D1.PolarisMail.ID }}`, etc.) with missingkey=error so any\n" +
			"undefined reference is a hard failure instead of a silent empty\n" +
			"string.",
		RunE: func(cmd *cobra.Command, _ []string) error {
			// --merge short-circuits the render flow.
			if mergeBase != "" || mergeOver != "" {
				return runMerge(cmd, mergeBase, mergeOver, outputPath)
			}
			return runRender(cmd, statePath, envPath, serviceArg, dryRun)
		},
	}

	c.Flags().StringVar(&statePath, "state-path", "", "override .deploy-state.json path (default: repo-root .deploy-state.json)")
	c.Flags().StringVar(&envPath, "env-path", "", "override .env.deploy path (default: repo-root .env.deploy)")
	c.Flags().StringVar(&serviceArg, "service", "", "render only the named service (api|in|out|panel|cli-installer)")
	c.Flags().BoolVar(&dryRun, "dry-run", false, "print rendered bytes to stdout instead of writing wrangler.local.jsonc")

	// One-shot merge mode: deep-merge two JSONC files.
	c.Flags().StringVar(&mergeBase, "merge", "", "JSONC base file; pairs with --overlay (one-shot deep-merge, no render)")
	c.Flags().StringVar(&mergeOver, "overlay", "", "JSONC overlay file for --merge")
	c.Flags().StringVarP(&outputPath, "output", "o", "", "write merge result to this path (default: stdout)")

	return c
}

// runRender is the regular render path. It reads state + env, builds
// inputs, validates, and renders every template (or just the one named
// by --service).
func runRender(cmd *cobra.Command, statePath, envPath, serviceArg string, dryRun bool) error {
	statePath = pickPath(statePath, defaultStatePath)
	envPath = pickPath(envPath, defaultEnvDeployPath)

	doc, err := readState(statePath)
	if err != nil {
		return err
	}

	in, err := wranglercfg.LoadInputs(doc, envPath)
	if err != nil {
		return err
	}
	if err := in.Validate(); err != nil {
		return err
	}

	services, err := selectServices(serviceArg)
	if err != nil {
		return err
	}

	for _, svc := range services {
		tplPath := filepath.Join(svc.Dir, "wrangler.local.template.jsonc")
		outPath := filepath.Join(svc.Dir, "wrangler.local.jsonc")

		tpl, err := os.ReadFile(tplPath)
		if err != nil {
			if os.IsNotExist(err) {
				fmt.Fprintf(cmd.ErrOrStderr(), "[render] %s: no template (skipping)\n", svc.Name)
				continue
			}
			return fmt.Errorf("read template %s: %w", tplPath, err)
		}

		rendered, err := wranglercfg.Render(tpl, in)
		if err != nil {
			return fmt.Errorf("render %s: %w", svc.Name, err)
		}

		if dryRun {
			fmt.Fprintf(cmd.OutOrStdout(), "// --- %s (%s) ---\n", svc.Name, outPath)
			if _, err := cmd.OutOrStdout().Write(rendered); err != nil {
				return err
			}
			continue
		}

		if err := atomicWrite(outPath, rendered, 0o644); err != nil {
			return err
		}
		fmt.Fprintf(cmd.ErrOrStderr(), "[render] %s → %s\n", svc.Name, outPath)
	}
	return nil
}

// runMerge implements `setup infra render --merge BASE --overlay OVERLAY
// [-o OUT]`. Deep-merges two JSONC files using the same
// comment-preserving merger the render flow uses internally.
func runMerge(cmd *cobra.Command, base, overlay, outPath string) error {
	if base == "" || overlay == "" {
		return fmt.Errorf("--merge and --overlay must both be set (got base=%q overlay=%q)", base, overlay)
	}
	baseBytes, err := os.ReadFile(base)
	if err != nil {
		return fmt.Errorf("read base %s: %w", base, err)
	}
	overlayBytes, err := os.ReadFile(overlay)
	if err != nil {
		return fmt.Errorf("read overlay %s: %w", overlay, err)
	}
	merged, err := wranglercfg.Merge(baseBytes, overlayBytes)
	if err != nil {
		return fmt.Errorf("merge %s + %s: %w", base, overlay, err)
	}
	if outPath == "" || outPath == "-" || strings.EqualFold(outPath, "stdout") {
		_, err := cmd.OutOrStdout().Write(merged)
		return err
	}
	return atomicWrite(outPath, merged, 0o644)
}

// selectServices resolves --service into the list to render. An empty
// arg means "render everything". An unknown name is a hard error: typos
// in --service are operator-visible (the user got it wrong) rather than
// silently rendering nothing.
func selectServices(arg string) ([]renderableService, error) {
	if arg == "" {
		return renderableServices, nil
	}
	for _, svc := range renderableServices {
		if svc.Name == arg {
			return []renderableService{svc}, nil
		}
	}
	names := make([]string, 0, len(renderableServices))
	for _, svc := range renderableServices {
		names = append(names, svc.Name)
	}
	return nil, fmt.Errorf("unknown service %q — expected one of: %s", arg, strings.Join(names, ", "))
}

// readState loads .deploy-state.json. If the file is missing we return
// an empty Doc — the LoadInputs path will then read env-only and
// Validate will produce a specific error about which state keys are
// missing. That's friendlier than a generic "no state file" failure.
func readState(path string) (*state.Doc, error) {
	s := state.Open(path)
	doc, err := s.Read()
	if err != nil {
		return nil, fmt.Errorf("read state %s: %w", path, err)
	}
	return doc, nil
}

// atomicWrite writes `data` to `path` via a sibling tempfile and rename.
// Mode is applied to the temp file before the rename so the final
// pathname always has the requested permissions.
func atomicWrite(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", dir, err)
	}
	tmp, err := os.CreateTemp(dir, ".wrangler-render-*.tmp")
	if err != nil {
		return fmt.Errorf("temp file: %w", err)
	}
	cleanup := func() { _ = os.Remove(tmp.Name()) }
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("write temp: %w", err)
	}
	if err := tmp.Chmod(mode); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("chmod temp: %w", err)
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return fmt.Errorf("close temp: %w", err)
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		cleanup()
		return fmt.Errorf("rename %s → %s: %w", tmp.Name(), path, err)
	}
	return nil
}

func pickPath(override, fallback string) string {
	if override != "" {
		return override
	}
	return fallback
}
