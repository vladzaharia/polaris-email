package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/output"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/daemons/bridge"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/wizards"
)

// bridgeFlags is the common flag set shared across every `setup bridge`
// leaf. --dir defaults to ./polaris-bridge; --from-file lets the wizard
// run non-interactively from a JSON or YAML input snapshot.
type bridgeFlags struct {
	Dir            string
	FromFile       string
	NonInteractive bool
	Yes            bool
	ImageTag       string
	Profiles       []string
}

// addCommonFlags attaches the shared bridge flags. Each leaf adds its
// own extras on top.
func addCommonFlags(c *cobra.Command, f *bridgeFlags) {
	c.Flags().StringVar(&f.Dir, "dir", bridge.DefaultDir, "project directory (compose + secrets land here)")
	c.Flags().StringVar(&f.FromFile, "from-file", "", "non-interactive input snapshot (json|yaml)")
	c.Flags().BoolVar(&f.NonInteractive, "non-interactive", false, "fail rather than prompt for missing fields")
	c.Flags().BoolVar(&f.Yes, "yes", false, "skip destructive confirmation prompts")
	c.Flags().StringVar(&f.ImageTag, "image-tag", "", "override the bridge image tag (defaults to the CLI version)")
	c.Flags().StringSliceVar(&f.Profiles, "profile", nil, "docker compose profiles to activate (e.g. lego)")
}

// loadInput builds the BridgeSetupInput. Resolution order:
//  1. --from-file
//  2. .polaris-setup.json under --dir
//  3. interactive prompt
//  4. (non-interactive) error
func loadInput(f *bridgeFlags, cliVersion string) (*bridge.BridgeSetupInput, error) {
	if f.FromFile != "" {
		in, err := bridge.LoadInputFile(f.FromFile)
		if err != nil {
			return nil, err
		}
		applyFlagOverrides(in, f)
		in.Defaults(cliVersion)
		return in, in.Validate()
	}
	snapPath := joinPath(f.Dir, ".polaris-setup.json")
	if _, err := os.Stat(snapPath); err == nil {
		in, err := bridge.LoadInputFile(snapPath)
		if err != nil {
			return nil, fmt.Errorf("load %s: %w", snapPath, err)
		}
		applyFlagOverrides(in, f)
		in.Defaults(cliVersion)
		return in, in.Validate()
	}
	if f.NonInteractive {
		return nil, fmt.Errorf("--non-interactive requires --from-file or an existing %s", snapPath)
	}
	in, err := bridge.Prompt(&bridge.BridgeSetupInput{Dir: f.Dir, ImageTag: f.ImageTag}, cliVersion)
	if err != nil {
		return nil, err
	}
	applyFlagOverrides(in, f)
	return in, in.Validate()
}

func applyFlagOverrides(in *bridge.BridgeSetupInput, f *bridgeFlags) {
	if f.Dir != "" {
		in.Dir = f.Dir
	}
	if f.ImageTag != "" {
		in.ImageTag = f.ImageTag
	}
}

// joinPath is a thin shim so we can stub it in tests.
func joinPath(dir, file string) string {
	if dir == "" {
		return file
	}
	if strings.HasSuffix(dir, "/") {
		return dir + file
	}
	return dir + "/" + file
}

// newSetupBridgeCmd is the `setup bridge` subtree. opts carries the
// CLI version + MakeClient hook so this package does not have to
// re-import internal/cmds.
func newSetupBridgeCmd(opts Options) *cobra.Command {
	parentFlags := &bridgeFlags{}
	c := &cobra.Command{
		Use:   "bridge",
		Short: "Bootstrap, register, and verify a polaris-mail-bridge deployment",
		Long: "Container-bootstrap wizard for polaris-mail-bridge.\n" +
			"\n" +
			"Bare `setup bridge` runs the happy path: precheck → init → register → up → verify.\n" +
			"Granular leaves (`precheck`, `init`, `register`, `up`, `verify`, `status`, `down`,\n" +
			"`destroy`, `upgrade`) are also available for advanced flows.\n" +
			"\n" +
			"Both deployment modes (local and tailscale) are first-class; the wizard's mode\n" +
			"select has no default — operators must choose explicitly.",
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runBridgeHappyPath(cmd, parentFlags, opts)
		},
	}
	addCommonFlags(c, parentFlags)
	c.AddCommand(
		newBridgePrecheckCmd(opts),
		newBridgeInitCmd(opts),
		newBridgeRegisterCmd(opts),
		newBridgeUpCmd(opts),
		newBridgeVerifyCmd(opts),
		newBridgeStatusCmd(opts),
		newBridgeDownCmd(opts),
		newBridgeDestroyCmd(opts),
		newBridgeUpgradeCmd(opts),
	)
	return c
}

// --- happy path -----------------------------------------------------

func runBridgeHappyPath(cmd *cobra.Command, f *bridgeFlags, opts Options) error {
	ctx := cmd.Context()
	out := cmd.OutOrStdout()

	in, err := loadInput(f, opts.CLIVersion)
	if err != nil {
		return err
	}

	// Pre-checks. Operator can choose to continue even when some checks
	// fail (via --yes); without --yes we abort on the first hard fail.
	results := bridge.PreFlight(ctx, in, bridge.DefaultDeps())
	renderPrecheckTable(out, results)
	if !f.Yes {
		for _, r := range results {
			if r.Status == bridge.StatusFail {
				return fmt.Errorf("precheck %s failed: %s (re-run with --yes to override)", r.Name, r.Message)
			}
		}
	}

	// Init.
	files, err := bridge.Init(in, bridge.InitOptions{CLIVersion: opts.CLIVersion})
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "wrote %d files to %s\n", len(files), in.Dir)

	// Register.
	if opts.MakeClient == nil {
		return fmt.Errorf("no api client wired; pass setup.Options{MakeClient: ...} from the cmds package")
	}
	cl, err := opts.MakeClient()
	if err != nil {
		return err
	}
	reg, err := registerBridge(ctx, cl, in, out)
	if err != nil {
		return err
	}

	// Persist + re-render with access tokens baked into .env.
	if _, err := bridge.PersistRegistration(in.Dir, in, reg); err != nil {
		return err
	}
	rc := bridge.NewRenderContext(in, opts.CLIVersion, reg.AccessClientID, reg.AccessClientSecret, time.Now())
	rendered, err := bridge.Render(rc)
	if err != nil {
		return err
	}
	if err := bridge.WriteFiles(in.Dir, rendered); err != nil {
		return err
	}

	// Up.
	if err := bridge.Up(ctx, in, bridge.UpOptions{LogTo: out, Profiles: f.Profiles}); err != nil {
		return err
	}

	// Verify (best-effort — operator sees the table either way).
	probes := bridge.Probe(ctx, in, &bridge.ProbeDeps{LookupClient: lookupFromClient(cl)})
	renderProbeTable(out, probes)
	for _, p := range probes {
		if p.Status == bridge.ProbeFail {
			return fmt.Errorf("post-up probe %s failed: %s", p.Name, p.Message)
		}
	}
	fmt.Fprintln(out, "bridge is up.")
	return nil
}

// --- leaves --------------------------------------------------------

func newBridgePrecheckCmd(opts Options) *cobra.Command {
	f := &bridgeFlags{}
	c := &cobra.Command{
		Use:   "precheck",
		Short: "Run prechecks without making changes",
		RunE: func(cmd *cobra.Command, _ []string) error {
			in, err := loadInput(f, opts.CLIVersion)
			if err != nil {
				return err
			}
			results := bridge.PreFlight(cmd.Context(), in, bridge.DefaultDeps())
			renderPrecheckTable(cmd.OutOrStdout(), results)
			for _, r := range results {
				if r.Status == bridge.StatusFail {
					return fmt.Errorf("precheck %s failed", r.Name)
				}
			}
			return nil
		},
	}
	addCommonFlags(c, f)
	return c
}

func newBridgeInitCmd(opts Options) *cobra.Command {
	f := &bridgeFlags{}
	c := &cobra.Command{
		Use:   "init",
		Short: "Render docker-compose / .env / bridge.toml / README into <dir>",
		RunE: func(cmd *cobra.Command, _ []string) error {
			in, err := loadInput(f, opts.CLIVersion)
			if err != nil {
				return err
			}
			files, err := bridge.Init(in, bridge.InitOptions{CLIVersion: opts.CLIVersion})
			if err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "wrote %d files to %s\n", len(files), in.Dir)
			return nil
		},
	}
	addCommonFlags(c, f)
	return c
}

func newBridgeRegisterCmd(opts Options) *cobra.Command {
	f := &bridgeFlags{}
	c := &cobra.Command{
		Use:   "register",
		Short: "Mint creds via the control plane and persist them under <dir>/secrets/",
		RunE: func(cmd *cobra.Command, _ []string) error {
			in, err := loadInput(f, opts.CLIVersion)
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
			reg, err := registerBridge(cmd.Context(), cl, in, cmd.OutOrStdout())
			if err != nil {
				return err
			}
			if _, err := bridge.PersistRegistration(in.Dir, in, reg); err != nil {
				return err
			}
			rc := bridge.NewRenderContext(in, opts.CLIVersion, reg.AccessClientID, reg.AccessClientSecret, time.Now())
			rendered, err := bridge.Render(rc)
			if err != nil {
				return err
			}
			return bridge.WriteFiles(in.Dir, rendered)
		},
	}
	addCommonFlags(c, f)
	return c
}

func newBridgeUpCmd(opts Options) *cobra.Command {
	f := &bridgeFlags{}
	c := &cobra.Command{
		Use:   "up",
		Short: "docker compose pull && docker compose up -d in <dir>",
		RunE: func(cmd *cobra.Command, _ []string) error {
			in, err := loadInput(f, opts.CLIVersion)
			if err != nil {
				return err
			}
			return bridge.Up(cmd.Context(), in, bridge.UpOptions{LogTo: cmd.OutOrStdout(), Profiles: f.Profiles})
		},
	}
	addCommonFlags(c, f)
	return c
}

func newBridgeVerifyCmd(opts Options) *cobra.Command {
	f := &bridgeFlags{}
	c := &cobra.Command{
		Use:   "verify",
		Short: "Run post-up SMTPS / IMAP / webhook / heartbeat probes",
		RunE: func(cmd *cobra.Command, _ []string) error {
			in, err := loadInput(f, opts.CLIVersion)
			if err != nil {
				return err
			}
			var cl *client.Client
			if opts.MakeClient != nil {
				cl, _ = opts.MakeClient()
			}
			deps := &bridge.ProbeDeps{}
			if cl != nil {
				deps.LookupClient = lookupFromClient(cl)
			}
			probes := bridge.Probe(cmd.Context(), in, deps)
			renderProbeTable(cmd.OutOrStdout(), probes)
			for _, p := range probes {
				if p.Status == bridge.ProbeFail {
					return fmt.Errorf("probe %s failed: %s", p.Name, p.Message)
				}
			}
			return nil
		},
	}
	addCommonFlags(c, f)
	return c
}

func newBridgeStatusCmd(opts Options) *cobra.Command {
	f := &bridgeFlags{}
	c := &cobra.Command{
		Use:   "status",
		Short: "docker compose ps for the bridge project",
		RunE: func(cmd *cobra.Command, _ []string) error {
			in, err := loadInput(f, opts.CLIVersion)
			if err != nil {
				return err
			}
			cs, err := bridge.Status(cmd.Context(), in.Dir, nil)
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
	addCommonFlags(c, f)
	return c
}

func newBridgeDownCmd(opts Options) *cobra.Command {
	f := &bridgeFlags{}
	var volumes bool
	c := &cobra.Command{
		Use:   "down",
		Short: "docker compose down in <dir>",
		RunE: func(cmd *cobra.Command, _ []string) error {
			in, err := loadInput(f, opts.CLIVersion)
			if err != nil {
				return err
			}
			out, err := bridge.Down(cmd.Context(), in, volumes, nil)
			_, _ = cmd.OutOrStdout().Write(out)
			return err
		},
	}
	addCommonFlags(c, f)
	c.Flags().BoolVar(&volumes, "volumes", false, "delete bridge-data + bridge-logs volumes")
	return c
}

func newBridgeDestroyCmd(opts Options) *cobra.Command {
	f := &bridgeFlags{}
	var confirmName string
	c := &cobra.Command{
		Use:   "destroy",
		Short: "Remove the bridge project directory + every secret it holds",
		RunE: func(cmd *cobra.Command, _ []string) error {
			in, err := loadInput(f, opts.CLIVersion)
			if err != nil {
				return err
			}
			if !f.Yes && confirmName != in.BridgeName {
				return fmt.Errorf("destructive: pass --confirm-name=%s (or --yes)", in.BridgeName)
			}
			if err := bridge.Destroy(in.Dir); err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "removed %s\n", in.Dir)
			return nil
		},
	}
	addCommonFlags(c, f)
	c.Flags().StringVar(&confirmName, "confirm-name", "", "must equal the bridge name (guard)")
	return c
}

func newBridgeUpgradeCmd(opts Options) *cobra.Command {
	f := &bridgeFlags{}
	c := &cobra.Command{
		Use:   "upgrade",
		Short: "Re-render compose with the current CLI's image tag and re-pull/up",
		RunE: func(cmd *cobra.Command, _ []string) error {
			in, err := loadInput(f, opts.CLIVersion)
			if err != nil {
				return err
			}
			// Force the image tag to the CLI's current Version.
			in.ImageTag = opts.CLIVersion
			files, err := bridge.Init(in, bridge.InitOptions{CLIVersion: opts.CLIVersion})
			if err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "re-rendered %d files; pulling new image\n", len(files))
			return bridge.Up(cmd.Context(), in, bridge.UpOptions{LogTo: cmd.OutOrStdout(), Profiles: f.Profiles})
		},
	}
	addCommonFlags(c, f)
	return c
}

// --- helpers --------------------------------------------------------

// registerBridge calls the existing wizards.RunBridgeRegister to mint
// creds via POST /v1/admin/bridges; the result is mapped onto
// bridge.RegistrationData so the bridge package stays free of
// internal/client.
func registerBridge(ctx context.Context, cl *client.Client, in *bridge.BridgeSetupInput, _ io.Writer) (*bridge.RegistrationData, error) {
	reg := wizards.BridgeRegisterInput{
		Name:        in.BridgeName,
		Environment: in.Environment,
		OutputForm:  "compose",
	}
	// Use a discard writer so the wizard's compose-snippet rendering
	// doesn't pollute the operator's terminal — we render our own
	// compose file from the bridge package's templates.
	resp, err := wizards.RunBridgeRegister(ctx, cl, &reg, io.Discard)
	if err != nil {
		return nil, fmt.Errorf("register bridge: %w", err)
	}
	if resp == nil {
		// Dry-run path — synthesize empty creds for downstream rendering.
		return &bridge.RegistrationData{BridgeName: in.BridgeName, Environment: in.Environment}, nil
	}
	raw, _ := json.Marshal(resp)
	return &bridge.RegistrationData{
		BridgeID:           resp.Bridge.ID,
		BridgeName:         resp.Bridge.Name,
		Environment:        resp.Bridge.Environment,
		HMACKeyID:          resp.HMACKeyID,
		HMACSecret:         resp.HMACSecret,
		AccessClientID:     resp.AccessClient,
		AccessClientSecret: resp.AccessToken,
		RegisteredAt:       time.Now().UTC(),
		Raw:                raw,
	}, nil
}

// lookupFromClient adapts a *client.Client to bridge.BridgeLookup. It
// goes through cl.DoJSON so the HMAC headers are signed for the admin
// API (the /v1/admin/bridges/lookup endpoint is auth'd).
func lookupFromClient(cl *client.Client) bridge.BridgeLookup {
	return &cliBridgeLookup{cl: cl}
}

type cliBridgeLookup struct{ cl *client.Client }

func (l *cliBridgeLookup) Lookup(ctx context.Context, name string) (*bridge.LookupResult, error) {
	var b client.Bridge
	if err := l.cl.DoJSON(ctx, "GET", "/v1/admin/bridges/lookup?name="+name, nil, nil, &b); err != nil {
		return nil, err
	}
	return &bridge.LookupResult{Name: b.Name, LastSeenAt: b.LastSeenAt}, nil
}

func renderPrecheckTable(w io.Writer, results []bridge.PreCheckResult) {
	t := &output.Table{Headers: []string{"CHECK", "STATUS", "MESSAGE"}}
	for _, r := range results {
		t.Rows = append(t.Rows, []string{r.Name, strings.ToUpper(string(r.Status)), r.Message})
	}
	_ = t.Render(w)
}

func renderProbeTable(w io.Writer, results []bridge.ProbeResult) {
	t := &output.Table{Headers: []string{"PROBE", "STATUS", "MESSAGE"}}
	for _, r := range results {
		t.Rows = append(t.Rows, []string{r.Name, strings.ToUpper(string(r.Status)), r.Message})
	}
	_ = t.Render(w)
}
