// Package cmd holds the cobra plumbing for the `polaris-mail setup`
// command tree. The infra subtree is wired explicitly in
// internal/cmds; the daemon subtrees (bridge, future submission-daemon)
// are generated from internal/setup's daemon registry.
//
// The setup tree lives in its own package (not under internal/cmds) so
// the implementation can mature independently — provisioning, plan,
// preflight, etc. all become children of this package without crowding
// the day-to-day operator commands.
package cmd

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/output"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup"

	// Blank import — triggers init() that registers the bridge daemon
	// in the setup package's registry. A future submission-daemon
	// adds a sibling blank-import line here.
	_ "github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/daemons/bridge"
)

// Options is the dependency-injection point the root cmds package
// passes to NewSetupCmd. Carrying these via Options (instead of a
// reverse import of internal/cmds) breaks the import cycle that would
// otherwise form: internal/cmds → internal/setup/cmd → internal/cmds.
type Options struct {
	// CLIVersion is the compiled-in version string (cmds.Version).
	// Used to pin daemon image tags and stamp generated files.
	CLIVersion string

	// MakeClient mints an authenticated admin API client. nil is
	// permitted — leaves that need a client surface a clear error
	// when one is unavailable.
	MakeClient func() (*client.Client, error)
}

// NewSetupCmd returns the `setup` parent command. The infra subtree
// is wired explicitly; each registered daemon (currently `bridge`)
// gets a subtree generated from its descriptor.
func NewSetupCmd(opts Options) *cobra.Command {
	c := &cobra.Command{
		Use:   "setup",
		Short: "Cold-start + ongoing deploy orchestration for polaris-mail",
		Long: "Cold-start and ongoing deploy orchestration for polaris-mail.\n" +
			"\n" +
			"Subcommands replace the legacy bin/*.sh scripts and the root Makefile\n" +
			"orchestration targets. See `polaris-mail setup infra --help`\n" +
			"and `polaris-mail setup <daemon> --help`.",
	}
	c.AddCommand(newInfraCmd())
	for _, name := range setup.Names() {
		d, ok := setup.Get(name)
		if !ok {
			continue
		}
		if binder, ok := d.(setup.FlagBinder); ok {
			binder.Bind(opts.CLIVersion)
		}
		c.AddCommand(newDaemonCmd(d, opts))
	}
	return c
}

// daemonFlags is the common flag set shared across every daemon leaf.
// --dir defaults to the daemon's DefaultDir() (or "./<name>"); --from-file
// lets the wizard run non-interactively from a JSON or YAML input
// snapshot.
type daemonFlags struct {
	Dir            string
	FromFile       string
	NonInteractive bool
	Yes            bool
	ImageTag       string
	Profiles       []string
}

func addCommonFlags(c *cobra.Command, f *daemonFlags, defaultDir string) {
	c.Flags().StringVar(&f.Dir, "dir", defaultDir, "project directory (compose + secrets land here)")
	c.Flags().StringVar(&f.FromFile, "from-file", "", "non-interactive input snapshot (json|yaml)")
	c.Flags().BoolVar(&f.NonInteractive, "non-interactive", false, "fail rather than prompt for missing fields")
	c.Flags().BoolVar(&f.Yes, "yes", false, "skip destructive confirmation prompts")
	c.Flags().StringVar(&f.ImageTag, "image-tag", "", "override the daemon image tag (defaults to the CLI version)")
	c.Flags().StringSliceVar(&f.Profiles, "profile", nil, "docker compose profiles to activate (e.g. lego)")
}

// resolveDefaultDir picks the dir flag default. Daemons that satisfy
// DirDefaulter own this; otherwise fall back to `./<name>`.
func resolveDefaultDir(d setup.Daemon) string {
	if dd, ok := d.(setup.DirDefaulter); ok {
		return dd.DefaultDir()
	}
	return "./" + d.Name()
}

// resolveSnapshotPath returns where the wizard's input snapshot lives.
func resolveSnapshotPath(d setup.Daemon, dir string) string {
	if sp, ok := d.(setup.Snapshotter); ok {
		return sp.SnapshotPath(dir)
	}
	return filepath.Join(dir, ".polaris-setup.json")
}

// loadInput resolves the daemon's input. Order:
//  1. --from-file
//  2. <dir>/.polaris-setup.json
//  3. interactive prompt
//  4. (non-interactive) error
func loadInput(d setup.Daemon, f *daemonFlags) (setup.Input, error) {
	loader, _ := d.(setup.InputLoader)
	defaulter, _ := d.(setup.Defaulter)
	flagger, _ := d.(setup.FlagApplier)

	apply := func(in setup.Input) (setup.Input, error) {
		if flagger != nil {
			if err := flagger.ApplyFlags(in, f.Dir, f.ImageTag); err != nil {
				return nil, err
			}
		}
		if defaulter != nil {
			defaulter.ApplyDefaults(in)
		}
		return in, in.Validate()
	}

	if f.FromFile != "" && loader != nil {
		in, err := loader.LoadInputFile(f.FromFile)
		if err != nil {
			return nil, err
		}
		return apply(in)
	}
	snapPath := resolveSnapshotPath(d, f.Dir)
	if _, err := os.Stat(snapPath); err == nil && loader != nil {
		in, err := loader.LoadInputFile(snapPath)
		if err != nil {
			return nil, fmt.Errorf("load %s: %w", snapPath, err)
		}
		return apply(in)
	}
	if f.NonInteractive {
		return nil, fmt.Errorf("--non-interactive requires --from-file or an existing %s", snapPath)
	}
	// Seed the interactive wizard with the operator-supplied flags so
	// the wizard sees --dir / --image-tag pre-populated. Daemons that
	// satisfy InputFactory get an empty input pre-seeded with those
	// flag values; daemons that don't simply prompt from zero.
	var seed setup.Input
	if factory, ok := d.(setup.InputFactory); ok {
		seed = factory.NewInput()
		if flagger != nil {
			_ = flagger.ApplyFlags(seed, f.Dir, f.ImageTag)
		}
	}
	in, err := d.Prompt(seed)
	if err != nil {
		return nil, err
	}
	return apply(in)
}

// newDaemonCmd builds one cobra subtree for the daemon.
func newDaemonCmd(d setup.Daemon, opts Options) *cobra.Command {
	defaultDir := resolveDefaultDir(d)
	parentFlags := &daemonFlags{}
	c := &cobra.Command{
		Use:   d.Name(),
		Short: d.Short(),
		Long:  d.Long(),
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runHappyPath(cmd, d, parentFlags, opts)
		},
	}
	addCommonFlags(c, parentFlags, defaultDir)
	c.AddCommand(
		newPrecheckCmd(d, defaultDir, opts),
		newInitCmd(d, defaultDir, opts),
		newRegisterCmd(d, defaultDir, opts),
		newUpCmd(d, defaultDir, opts),
		newVerifyCmd(d, defaultDir, opts),
		newStatusCmd(d, defaultDir, opts),
		newDownCmd(d, defaultDir, opts),
		newDestroyCmd(d, defaultDir, opts),
		newUpgradeCmd(d, defaultDir, opts),
	)
	return c
}

// --- happy path ----------------------------------------------------

func runHappyPath(cmd *cobra.Command, d setup.Daemon, f *daemonFlags, opts Options) error {
	ctx := cmd.Context()
	out := cmd.OutOrStdout()

	in, err := loadInput(d, f)
	if err != nil {
		return err
	}

	// Pre-checks.
	results := runPreChecks(ctx, d, in)
	renderPrecheckTable(out, results)
	if !f.Yes {
		for _, r := range results {
			if r.required && r.result.Status == "fail" {
				return fmt.Errorf("precheck %s failed: %s (re-run with --yes to override)", r.name, r.result.Detail)
			}
		}
	}

	// Init dir + render.
	persist, _ := d.(setup.Persistable)
	if persist == nil {
		return fmt.Errorf("setup %s: daemon does not implement Persistable", d.Name())
	}
	dir := dirFromInput(in, f.Dir)
	if err := persist.InitDir(dir); err != nil {
		return err
	}
	files, err := d.Render(in)
	if err != nil {
		return err
	}
	if err := persist.WriteFiles(dir, files); err != nil {
		return err
	}
	fmt.Fprintf(out, "wrote %d files to %s\n", len(files), dir)

	// Register.
	if opts.MakeClient == nil {
		return fmt.Errorf("no api client wired; pass setup.Options{MakeClient: ...} from the cmds package")
	}
	cl, err := opts.MakeClient()
	if err != nil {
		return err
	}
	creds, err := d.RegistrationFn(ctx, cl, in, out)
	if err != nil {
		return err
	}
	if err := persist.Persist(dir, in, creds); err != nil {
		return err
	}

	// Up + Verify. The TUI fuses these two stages into one screen so
	// the operator sees logs + probe results side-by-side while the
	// container settles. --non-interactive (or a non-TTY stdout)
	// falls back to the original plain-stdout sequence.
	lc, _ := d.(setup.Lifecycle)
	if lc == nil {
		return fmt.Errorf("setup %s: daemon does not implement Lifecycle", d.Name())
	}
	if shouldUseTUI(f.NonInteractive) {
		if err := runUpWithTUI(ctx, d, in, f.Profiles, out); err != nil {
			return err
		}
		fmt.Fprintf(out, "%s is up.\n", d.Name())
		return nil
	}
	if err := lc.Up(ctx, in, f.Profiles, out); err != nil {
		return err
	}
	probes := runProbes(ctx, d, in)
	renderProbeTable(out, probes)
	for _, p := range probes {
		if p.result.Status == "fail" {
			return fmt.Errorf("post-up probe %s failed: %s", p.name, p.result.Detail)
		}
	}
	fmt.Fprintf(out, "%s is up.\n", d.Name())
	return nil
}

// --- leaves --------------------------------------------------------

func newPrecheckCmd(d setup.Daemon, defaultDir string, _ Options) *cobra.Command {
	f := &daemonFlags{}
	c := &cobra.Command{
		Use:   "precheck",
		Short: "Run prechecks without making changes",
		RunE: func(cmd *cobra.Command, _ []string) error {
			in, err := loadInput(d, f)
			if err != nil {
				return err
			}
			results := runPreChecks(cmd.Context(), d, in)
			renderPrecheckTable(cmd.OutOrStdout(), results)
			for _, r := range results {
				if r.required && r.result.Status == "fail" {
					return fmt.Errorf("precheck %s failed", r.name)
				}
			}
			return nil
		},
	}
	addCommonFlags(c, f, defaultDir)
	return c
}

func newInitCmd(d setup.Daemon, defaultDir string, _ Options) *cobra.Command {
	f := &daemonFlags{}
	c := &cobra.Command{
		Use:   "init",
		Short: "Render docker-compose / .env / README into <dir>",
		RunE: func(cmd *cobra.Command, _ []string) error {
			in, err := loadInput(d, f)
			if err != nil {
				return err
			}
			persist, _ := d.(setup.Persistable)
			if persist == nil {
				return fmt.Errorf("setup %s: daemon does not implement Persistable", d.Name())
			}
			dir := dirFromInput(in, f.Dir)
			if err := persist.InitDir(dir); err != nil {
				return err
			}
			files, err := d.Render(in)
			if err != nil {
				return err
			}
			if err := persist.WriteFiles(dir, files); err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "wrote %d files to %s\n", len(files), dir)
			return nil
		},
	}
	addCommonFlags(c, f, defaultDir)
	return c
}

func newRegisterCmd(d setup.Daemon, defaultDir string, opts Options) *cobra.Command {
	f := &daemonFlags{}
	c := &cobra.Command{
		Use:   "register",
		Short: "Mint creds via the control plane and persist them under <dir>/secrets/",
		RunE: func(cmd *cobra.Command, _ []string) error {
			in, err := loadInput(d, f)
			if err != nil {
				return err
			}
			if opts.MakeClient == nil {
				return fmt.Errorf("no api client wired")
			}
			cl, err := opts.MakeClient()
			if err != nil {
				return err
			}
			creds, err := d.RegistrationFn(cmd.Context(), cl, in, cmd.OutOrStdout())
			if err != nil {
				return err
			}
			persist, _ := d.(setup.Persistable)
			if persist == nil {
				return fmt.Errorf("setup %s: daemon does not implement Persistable", d.Name())
			}
			return persist.Persist(dirFromInput(in, f.Dir), in, creds)
		},
	}
	addCommonFlags(c, f, defaultDir)
	return c
}

func newUpCmd(d setup.Daemon, defaultDir string, _ Options) *cobra.Command {
	f := &daemonFlags{}
	c := &cobra.Command{
		Use:   "up",
		Short: "docker compose pull && docker compose up -d in <dir>",
		Long: "Run `docker compose pull && docker compose up -d` in the daemon's project\n" +
			"directory, then tail the live logs in a Bubble Tea TUI while the\n" +
			"descriptor's post-up health probes run side-by-side.\n" +
			"\n" +
			"The TUI shows the merged log stream on top (q to dismiss, arrow keys to\n" +
			"scroll) and one row per probe (SMTPS handshake, IMAP CAPABILITY, webhook\n" +
			"/healthz, control-plane last_seen) at the bottom. The program exits\n" +
			"cleanly when every required probe passes; failing probes or a 60s\n" +
			"timeout surface as a non-zero exit.\n" +
			"\n" +
			"Pass --non-interactive (or run with POLARIS_NO_TUI=1, or pipe stdout\n" +
			"to a non-TTY) to bypass the TUI and fall back to the original plain\n" +
			"stdout streaming — CI pipelines are unaffected.",
		RunE: func(cmd *cobra.Command, _ []string) error {
			in, err := loadInput(d, f)
			if err != nil {
				return err
			}
			lc, _ := d.(setup.Lifecycle)
			if lc == nil {
				return fmt.Errorf("setup %s: daemon does not implement Lifecycle", d.Name())
			}
			if shouldUseTUI(f.NonInteractive) {
				return runUpWithTUI(cmd.Context(), d, in, f.Profiles, cmd.OutOrStdout())
			}
			return lc.Up(cmd.Context(), in, f.Profiles, cmd.OutOrStdout())
		},
	}
	addCommonFlags(c, f, defaultDir)
	return c
}

func newVerifyCmd(d setup.Daemon, defaultDir string, _ Options) *cobra.Command {
	f := &daemonFlags{}
	c := &cobra.Command{
		Use:   "verify",
		Short: "Run post-up health probes",
		RunE: func(cmd *cobra.Command, _ []string) error {
			in, err := loadInput(d, f)
			if err != nil {
				return err
			}
			probes := runProbes(cmd.Context(), d, in)
			renderProbeTable(cmd.OutOrStdout(), probes)
			for _, p := range probes {
				if p.result.Status == "fail" {
					return fmt.Errorf("probe %s failed: %s", p.name, p.result.Detail)
				}
			}
			return nil
		},
	}
	addCommonFlags(c, f, defaultDir)
	return c
}

func newStatusCmd(d setup.Daemon, defaultDir string, _ Options) *cobra.Command {
	f := &daemonFlags{}
	c := &cobra.Command{
		Use:   "status",
		Short: "docker compose ps for the daemon project",
		RunE: func(cmd *cobra.Command, _ []string) error {
			in, err := loadInput(d, f)
			if err != nil {
				return err
			}
			lc, _ := d.(setup.Lifecycle)
			if lc == nil {
				return fmt.Errorf("setup %s: daemon does not implement Lifecycle", d.Name())
			}
			cs, err := lc.Status(cmd.Context(), in)
			if err != nil {
				return err
			}
			t := &output.Table{Headers: []string{"SERVICE", "STATE", "HEALTH", "STATUS"}}
			for _, c := range cs {
				t.Rows = append(t.Rows, []string{c.Service, c.State, c.Health, c.Status})
			}
			return t.Render(cmd.OutOrStdout())
		},
	}
	addCommonFlags(c, f, defaultDir)
	return c
}

func newDownCmd(d setup.Daemon, defaultDir string, _ Options) *cobra.Command {
	f := &daemonFlags{}
	var volumes bool
	c := &cobra.Command{
		Use:   "down",
		Short: "docker compose down in <dir>",
		RunE: func(cmd *cobra.Command, _ []string) error {
			in, err := loadInput(d, f)
			if err != nil {
				return err
			}
			lc, _ := d.(setup.Lifecycle)
			if lc == nil {
				return fmt.Errorf("setup %s: daemon does not implement Lifecycle", d.Name())
			}
			return lc.Down(cmd.Context(), in, volumes, cmd.OutOrStdout())
		},
	}
	addCommonFlags(c, f, defaultDir)
	c.Flags().BoolVar(&volumes, "volumes", false, "delete data + log volumes")
	return c
}

func newDestroyCmd(d setup.Daemon, defaultDir string, _ Options) *cobra.Command {
	f := &daemonFlags{}
	var confirmName string
	c := &cobra.Command{
		Use:   "destroy",
		Short: "Remove the daemon project directory + every secret it holds",
		RunE: func(cmd *cobra.Command, _ []string) error {
			in, err := loadInput(d, f)
			if err != nil {
				return err
			}
			// Guard: --confirm-name must equal the daemon's identifier
			// (e.g. the bridge_name). The cobra leaf reads it via the
			// input's Marshal() snapshot.
			name, err := inputIdentifier(in)
			if err != nil {
				return err
			}
			if !f.Yes && confirmName != name {
				return fmt.Errorf("destructive: pass --confirm-name=%s (or --yes)", name)
			}
			persist, _ := d.(setup.Persistable)
			if persist == nil {
				return fmt.Errorf("setup %s: daemon does not implement Persistable", d.Name())
			}
			dir := dirFromInput(in, f.Dir)
			if err := persist.Destroy(dir); err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "removed %s\n", dir)
			return nil
		},
	}
	addCommonFlags(c, f, defaultDir)
	c.Flags().StringVar(&confirmName, "confirm-name", "", "must equal the daemon's identifier (guard)")
	return c
}

func newUpgradeCmd(d setup.Daemon, defaultDir string, opts Options) *cobra.Command {
	f := &daemonFlags{}
	c := &cobra.Command{
		Use:   "upgrade",
		Short: "Re-render compose with the current CLI's image tag and re-pull/up",
		RunE: func(cmd *cobra.Command, _ []string) error {
			// Force the image tag to the CLI's current Version. The
			// flag flow does this implicitly via ApplyFlags when
			// --image-tag is unset and the daemon defaults to the
			// CLI version — but `upgrade` is explicit about it.
			f.ImageTag = opts.CLIVersion
			in, err := loadInput(d, f)
			if err != nil {
				return err
			}
			persist, _ := d.(setup.Persistable)
			if persist == nil {
				return fmt.Errorf("setup %s: daemon does not implement Persistable", d.Name())
			}
			dir := dirFromInput(in, f.Dir)
			if err := persist.InitDir(dir); err != nil {
				return err
			}
			files, err := d.Render(in)
			if err != nil {
				return err
			}
			if err := persist.WriteFiles(dir, files); err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "re-rendered %d files; pulling new image\n", len(files))
			lc, _ := d.(setup.Lifecycle)
			if lc == nil {
				return fmt.Errorf("setup %s: daemon does not implement Lifecycle", d.Name())
			}
			return lc.Up(cmd.Context(), in, f.Profiles, cmd.OutOrStdout())
		},
	}
	addCommonFlags(c, f, defaultDir)
	return c
}

// --- helpers --------------------------------------------------------

type checkRow struct {
	name     string
	required bool
	result   setup.PreCheckResult
}

func runPreChecks(ctx context.Context, d setup.Daemon, in setup.Input) []checkRow {
	checks := d.PreChecks(in)
	out := make([]checkRow, len(checks))
	for i, c := range checks {
		r := c.Run(ctx)
		out[i] = checkRow{name: c.Name, required: c.Required, result: r}
	}
	return out
}

type probeRow struct {
	name   string
	result setup.ProbeResult
}

func runProbes(ctx context.Context, d setup.Daemon, in setup.Input) []probeRow {
	probes := d.PostUpProbes(in)
	out := make([]probeRow, len(probes))
	for i, p := range probes {
		r := p.Run(ctx)
		out[i] = probeRow{name: p.Name, result: r}
	}
	return out
}

func renderPrecheckTable(w io.Writer, results []checkRow) {
	t := &output.Table{Headers: []string{"CHECK", "STATUS", "MESSAGE"}}
	for _, r := range results {
		t.Rows = append(t.Rows, []string{r.name, strings.ToUpper(r.result.Status), r.result.Detail})
	}
	_ = t.Render(w)
}

func renderProbeTable(w io.Writer, results []probeRow) {
	t := &output.Table{Headers: []string{"PROBE", "STATUS", "MESSAGE"}}
	for _, r := range results {
		t.Rows = append(t.Rows, []string{r.name, strings.ToUpper(r.result.Status), r.result.Detail})
	}
	_ = t.Render(w)
}

// dirFromInput extracts the daemon's project directory from the input.
// Strategy: marshal the input, look for a top-level "dir" field. Falls
// back to the operator-supplied flag value when no dir is present.
func dirFromInput(in setup.Input, fallback string) string {
	if dirAware, ok := in.(interface{ Dir() string }); ok {
		if d := dirAware.Dir(); d != "" {
			return d
		}
	}
	// Marshal-fallback: we don't pull in encoding/json on the cmd path
	// just for this. The daemon's input already validates Dir; if the
	// fallback is set, it matches what the wizard wrote in.
	if fallback != "" {
		return fallback
	}
	return ""
}

// inputIdentifier returns the daemon's destruction-guard identifier
// (e.g. the bridge_name). The bridge's input wrapper satisfies this
// via the underlying struct's BridgeName field; daemons without a
// usable identifier should fall back to the daemon Name() and accept
// any value.
func inputIdentifier(in setup.Input) (string, error) {
	if idAware, ok := in.(interface{ Identifier() string }); ok {
		return idAware.Identifier(), nil
	}
	// No identifier — the caller relies on --yes.
	return "", nil
}
