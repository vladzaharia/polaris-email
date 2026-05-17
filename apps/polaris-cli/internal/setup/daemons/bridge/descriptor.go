package bridge

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/platform"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/wizards"
)

// Descriptor implements setup.Daemon for the polaris-mail-bridge. The
// init() in this file registers it via setup.Register so any package
// that imports `daemons/bridge` (typically blank-imported from
// internal/setup/cmd) picks the descriptor up at startup.
//
// CLIVersion is the compiled-in CLI version string the cobra leaves
// pass through to Render so the bridge image tag matches the running
// CLI. The cobra generator stamps this via Bind() before invoking any
// method that needs it.
type Descriptor struct {
	cliVersion string
}

// New returns a fresh Descriptor. Mostly here for tests; production
// reaches the registered singleton via setup.Get("bridge").
func New() *Descriptor { return &Descriptor{} }

// Bind stamps the CLI version into the descriptor. The cobra generator
// in internal/setup/cmd/ calls this on the singleton before delegating
// to any method that needs the version (Render, RegistrationFn).
func (d *Descriptor) Bind(cliVersion string) { d.cliVersion = cliVersion }

// CLIVersion returns the stamped CLI version, or "v0.0.0-unknown" when
// Bind() has not yet been called (test contexts).
func (d *Descriptor) CLIVersion() string {
	if d.cliVersion == "" {
		return "v0.0.0-unknown"
	}
	return d.cliVersion
}

// Name implements setup.Daemon.
func (d *Descriptor) Name() string { return "bridge" }

// Short implements setup.Daemon.
func (d *Descriptor) Short() string {
	return "Bootstrap, register, and verify a polaris-mail-bridge deployment"
}

// Long implements setup.Daemon.
func (d *Descriptor) Long() string {
	return "Container-bootstrap wizard for polaris-mail-bridge.\n" +
		"\n" +
		"Bare `setup bridge` runs the happy path: precheck -> init -> register -> up -> verify.\n" +
		"Granular leaves (`precheck`, `init`, `register`, `up`, `verify`, `status`, `down`,\n" +
		"`destroy`, `upgrade`) are also available for advanced flows.\n" +
		"\n" +
		"Both deployment modes (local and tailscale) are first-class; the wizard's mode\n" +
		"select has no default — operators must choose explicitly."
}

// Prompt implements setup.Daemon. Wraps the existing interactive
// wizard. The initial Input is unwrapped from setup.Input back to the
// concrete *BridgeSetupInput so the existing Prompt() signature stays
// unchanged.
func (d *Descriptor) Prompt(initial setup.Input) (setup.Input, error) {
	seed, err := UnwrapInput(initial)
	if err != nil {
		return nil, err
	}
	out, err := Prompt(seed, d.CLIVersion())
	if err != nil {
		return nil, err
	}
	return WrapInput(out), nil
}

// PreChecks implements setup.Daemon. Each PreCheck closure delegates to
// the existing per-check function in prechecks.go so test coverage
// stays intact.
func (d *Descriptor) PreChecks(in setup.Input) []setup.PreCheck {
	concrete, err := UnwrapInput(in)
	if err != nil {
		return nil
	}
	deps := DefaultDeps()
	checks := []setup.PreCheck{
		{
			Name:        "dir-perms",
			Required:    true,
			Description: "Project directory is not world-readable",
			Run: func(_ context.Context) setup.PreCheckResult {
				return adaptPreCheck(checkDirectoryPerms(concrete))
			},
		},
		{
			Name:        "docker-info",
			Required:    true,
			Description: "Docker daemon is reachable",
			Run: func(ctx context.Context) setup.PreCheckResult {
				return adaptPreCheck(checkDocker(ctx, deps.Docker))
			},
		},
		{
			Name:        "compose-version",
			Required:    true,
			Description: "docker compose >= v2.20",
			Run: func(ctx context.Context) setup.PreCheckResult {
				return adaptPreCheck(checkComposeVersion(ctx, deps.Docker))
			},
		},
		{
			Name:        "port-smtps",
			Required:    true,
			Description: "SMTPS host port is free",
			Run: func(ctx context.Context) setup.PreCheckResult {
				return adaptPreCheck(checkPortFree(ctx, "smtps", concrete.SMTPSPort))
			},
		},
		{
			Name:        "port-imap",
			Required:    true,
			Description: "IMAP host port is free",
			Run: func(ctx context.Context) setup.PreCheckResult {
				return adaptPreCheck(checkPortFree(ctx, "imap", concrete.IMAPPort))
			},
		},
		{
			Name:        "port-webhook",
			Required:    true,
			Description: "Webhook host port is free",
			Run: func(ctx context.Context) setup.PreCheckResult {
				return adaptPreCheck(checkPortFree(ctx, "webhook", concrete.WebhookPort))
			},
		},
		{
			Name:        "polaris-api",
			Required:    true,
			Description: "Control plane is reachable",
			Run: func(ctx context.Context) setup.PreCheckResult {
				return adaptPreCheck(checkPolarisAPIReachable(ctx, concrete.PolarisAPIURL, deps.HTTPClient))
			},
		},
		{
			Name:        "public-url",
			Required:    true,
			Description: "Public URL is not a loopback address",
			Run: func(_ context.Context) setup.PreCheckResult {
				return adaptPreCheck(checkPublicURLNonLoopback(concrete.PublicURL))
			},
		},
	}
	if concrete.TLSSource == TLSMounted {
		checks = append(checks, setup.PreCheck{
			Name:        "tls-pem",
			Required:    false,
			Description: "Mounted PEM is readable + not expiring within 24h",
			Run: func(_ context.Context) setup.PreCheckResult {
				return adaptPreCheck(checkMountedTLSReadable(concrete.TLSDir))
			},
		})
	}
	return checks
}

// Render implements setup.Daemon. Delegates to the existing pipeline:
// NewRenderContext + Render. AccessClient credentials are zero-valued
// here (the cobra leaf calls Render a second time post-registration
// with real values).
func (d *Descriptor) Render(in setup.Input) ([]setup.File, error) {
	concrete, err := UnwrapInput(in)
	if err != nil {
		return nil, err
	}
	rc := NewRenderContext(concrete, d.CLIVersion(), "", "", time.Now())
	files, err := Render(rc)
	if err != nil {
		return nil, err
	}
	return adaptFiles(files), nil
}

// PostUpProbes implements setup.Daemon. Each Probe closure delegates
// to the existing per-probe function in probes.go.
func (d *Descriptor) PostUpProbes(in setup.Input) []setup.Probe {
	concrete, err := UnwrapInput(in)
	if err != nil {
		return nil
	}
	host := tlsProbeHost(concrete)
	httpClient := &http.Client{Timeout: 5 * time.Second}
	return []setup.Probe{
		{
			Name:    "tls-smtps",
			Timeout: 5 * time.Second,
			Run: func(ctx context.Context) setup.ProbeResult {
				return adaptProbe(probeTLS(ctx, "smtps", host, concrete.SMTPSPort))
			},
		},
		{
			Name:    "imap-greeting",
			Timeout: 5 * time.Second,
			Run: func(ctx context.Context) setup.ProbeResult {
				return adaptProbe(probeIMAPCapability(ctx, host, concrete.IMAPPort))
			},
		},
		{
			Name:    "http-webhook",
			Timeout: 5 * time.Second,
			Run: func(ctx context.Context) setup.ProbeResult {
				target := fmt.Sprintf("http://%s:%d/healthz", host, concrete.WebhookPort)
				return adaptProbe(probeHTTP(ctx, "webhook", target, httpClient))
			},
		},
	}
}

// SecretPaths implements setup.Daemon. The bridge persists four secret
// files under `<dir>/secrets/`; the paths are relative because the
// concrete directory is set on the input, not the descriptor.
func (d *Descriptor) SecretPaths() []setup.SecretSpec {
	return []setup.SecretSpec{
		{Path: "secrets/bridge_id", EnvVar: "BRIDGE_ID", Rotation: "rotate-via-api"},
		{Path: "secrets/hmac_key", EnvVar: "POLARIS_HMAC_KEY", Rotation: "rotate-via-api"},
		{Path: "secrets/access_client_id", EnvVar: "ACCESS_CLIENT_ID", Rotation: "rotate-via-api"},
		{Path: "secrets/access_client_secret", EnvVar: "ACCESS_CLIENT_SECRET", Rotation: "rotate-via-api"},
	}
}

// RegistrationFn implements setup.Daemon. Wraps the existing
// wizards.RunBridgeRegister so the bridge package stays free of the
// wizards/cobra/client coupling on read paths.
func (d *Descriptor) RegistrationFn(ctx context.Context, c *client.Client, in setup.Input, _ io.Writer) (setup.Credentials, error) {
	concrete, err := UnwrapInput(in)
	if err != nil {
		return nil, err
	}
	reg := wizards.BridgeRegisterInput{
		Name:        concrete.BridgeName,
		Environment: concrete.Environment,
		OutputForm:  "compose",
	}
	// Discard the wizard's compose-snippet rendering — we render our own
	// from the bridge templates package.
	resp, err := wizards.RunBridgeRegister(ctx, c, &reg, io.Discard)
	if err != nil {
		return nil, fmt.Errorf("register bridge: %w", err)
	}
	if resp == nil {
		// Dry-run path — synthesize empty creds for downstream rendering.
		return &Credentials{
			Data: &RegistrationData{
				BridgeName:  concrete.BridgeName,
				Environment: concrete.Environment,
			},
		}, nil
	}
	raw, _ := json.Marshal(resp)
	return &Credentials{
		Data: &RegistrationData{
			BridgeID:           resp.Bridge.ID,
			BridgeName:         resp.Bridge.Name,
			Environment:        resp.Bridge.Environment,
			HMACKeyID:          resp.HMACKeyID,
			HMACSecret:         resp.HMACSecret,
			AccessClientID:     resp.AccessClient,
			AccessClientSecret: resp.AccessToken,
			RegisteredAt:       time.Now().UTC(),
			Raw:                raw,
		},
	}, nil
}

// --- input wrapper --------------------------------------------------

// inputWrapper projects *BridgeSetupInput onto the setup.Input
// interface. The wrapper is needed because BridgeSetupInput has a Mode
// field that conflicts with the interface's Mode() method.
type inputWrapper struct{ in *BridgeSetupInput }

// WrapInput lifts *BridgeSetupInput into a setup.Input. Returns nil
// when the input is nil so callers can pass seeds through directly.
func WrapInput(in *BridgeSetupInput) setup.Input {
	if in == nil {
		return nil
	}
	return &inputWrapper{in: in}
}

// UnwrapInput returns the concrete *BridgeSetupInput backing a
// setup.Input. nil and the un-typed empty interface are treated as
// "no seed supplied" — Prompt seeds a zero-value input in that case.
func UnwrapInput(in setup.Input) (*BridgeSetupInput, error) {
	if in == nil {
		return &BridgeSetupInput{}, nil
	}
	w, ok := in.(*inputWrapper)
	if !ok {
		return nil, fmt.Errorf("bridge: setup.Input is %T, want *bridge.inputWrapper", in)
	}
	if w.in == nil {
		return &BridgeSetupInput{}, nil
	}
	return w.in, nil
}

// Validate implements setup.Input.
func (w *inputWrapper) Validate() error { return w.in.Validate() }

// Marshal implements setup.Input.
func (w *inputWrapper) Marshal() ([]byte, error) { return w.in.Marshal() }

// Unmarshal implements setup.Input.
func (w *inputWrapper) Unmarshal(data []byte) error { return w.in.Unmarshal(data) }

// Mode implements setup.Input.
func (w *inputWrapper) Mode() string { return w.in.ModeString() }

// Dir is used by the cobra generator to resolve the daemon's project
// directory from the input (used for snapshot path + destination dir
// for renders).
func (w *inputWrapper) Dir() string { return w.in.Dir }

// Identifier is used by the cobra generator's `destroy` leaf to gate
// the destructive action against the operator-supplied --confirm-name.
func (w *inputWrapper) Identifier() string { return w.in.BridgeName }

// ImageTag exposes the pinned container image tag so the cobra
// generator's TUI can show "image v1.4.2" in the title bar without
// reaching into the concrete BridgeSetupInput. The cobra leaf reads
// this via a small interface declared in internal/setup/cmd/up_tui.go.
func (w *inputWrapper) ImageTag() string { return w.in.ImageTag }

// --- credentials adapter --------------------------------------------

// Credentials is the setup.Credentials shape the bridge descriptor
// returns. Data is the concrete RegistrationData the cobra leaf passes
// back to PersistRegistration().
type Credentials struct {
	Data *RegistrationData
}

// CredentialsKind implements setup.Credentials.
func (c *Credentials) CredentialsKind() string { return "bridge" }

// --- private adapters ----------------------------------------------

func adaptPreCheck(r PreCheckResult) setup.PreCheckResult {
	out := setup.PreCheckResult{
		Status: string(r.Status),
		Detail: r.Message,
	}
	// "skip" prechecks map to "pass" in the generic surface — the
	// generic UI only renders pass/warn/fail. Operators that need to
	// see skips reach for the per-check report directly.
	if out.Status == string(StatusSkip) {
		out.Status = "pass"
	}
	return out
}

func adaptProbe(r ProbeResult) setup.ProbeResult {
	return setup.ProbeResult{
		Status: string(r.Status),
		Detail: r.Message,
	}
}

func adaptFiles(files []RenderedFile) []setup.File {
	out := make([]setup.File, len(files))
	for i, f := range files {
		out[i] = setup.File{
			Path:      f.RelPath,
			Contents:  f.Body,
			Mode:      f.Mode,
			Sensitive: f.Mode == 0o600,
		}
	}
	return out
}

// WriteSetupFiles writes a slice of setup.File entries into dir using
// platform.AtomicWrite. Sensitive files land at 0600 even if Mode says
// otherwise. The cobra generator calls this after Daemon.Render().
func WriteSetupFiles(dir string, files []setup.File) error {
	for _, f := range files {
		mode := f.Mode
		if f.Sensitive && mode != 0o600 {
			mode = 0o600
		}
		if err := platform.AtomicWrite(filepath.Join(dir, f.Path), f.Contents, mode); err != nil {
			return fmt.Errorf("write %s: %w", f.Path, err)
		}
	}
	return nil
}

// PrepareDir creates `<dir>/` and `<dir>/secrets/` with the right modes
// and refuses to proceed if the operator-supplied directory is world-
// readable. Called by the cobra generator before Render.
func PrepareDir(dir string) error {
	if err := platform.EnsureDir(dir, 0o750); err != nil {
		return err
	}
	if err := platform.EnsureDir(filepath.Join(dir, "secrets"), 0o700); err != nil {
		return err
	}
	return platform.RejectWorldReadableDir(dir)
}

// PathExists is a tiny helper the cobra generator uses to detect
// `<dir>/.polaris-setup.json` without pulling os into the cmd file.
func PathExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// --- Lifecycle / Persistable -----------------------------------------

// Up implements setup.Lifecycle.
func (d *Descriptor) Up(ctx context.Context, in setup.Input, profiles []string, logTo io.Writer) error {
	concrete, err := UnwrapInput(in)
	if err != nil {
		return err
	}
	return UpFn(ctx, concrete, UpOptions{Profiles: profiles, LogTo: logTo})
}

// UpFn is the package-level alias for Up() used by the descriptor
// method so the existing function name is preserved for direct callers
// (tests, alternate entry points).
var UpFn = Up

// Down implements setup.Lifecycle.
func (d *Descriptor) Down(ctx context.Context, in setup.Input, deleteVolumes bool, logTo io.Writer) error {
	concrete, err := UnwrapInput(in)
	if err != nil {
		return err
	}
	out, err := Down(ctx, concrete, deleteVolumes, nil)
	if logTo != nil {
		_, _ = logTo.Write(out)
	}
	return err
}

// Status implements setup.Lifecycle.
func (d *Descriptor) Status(ctx context.Context, in setup.Input) ([]setup.ContainerStatus, error) {
	concrete, err := UnwrapInput(in)
	if err != nil {
		return nil, err
	}
	cs, err := Status(ctx, concrete.Dir, nil)
	if err != nil {
		return nil, err
	}
	out := make([]setup.ContainerStatus, len(cs))
	for i, c := range cs {
		out[i] = setup.ContainerStatus{
			Service: c.Service, State: c.State, Health: c.Health, Status: c.Status,
		}
	}
	return out, nil
}

// InitDir implements setup.Persistable. Wraps PrepareDir for symmetry.
func (d *Descriptor) InitDir(dir string) error { return PrepareDir(dir) }

// WriteFiles implements setup.Persistable.
func (d *Descriptor) WriteFiles(dir string, files []setup.File) error {
	return WriteSetupFiles(dir, files)
}

// Persist implements setup.Persistable. Unwraps the bridge-specific
// Credentials adapter and delegates to PersistRegistration. After the
// secrets land, this also re-renders the .env with the access tokens
// baked in.
func (d *Descriptor) Persist(dir string, in setup.Input, creds setup.Credentials) error {
	concrete, err := UnwrapInput(in)
	if err != nil {
		return err
	}
	bc, ok := creds.(*Credentials)
	if !ok || bc == nil || bc.Data == nil {
		return fmt.Errorf("bridge: Persist: credentials are %T, want *bridge.Credentials", creds)
	}
	if _, err := PersistRegistration(dir, concrete, bc.Data); err != nil {
		return err
	}
	rc := NewRenderContext(concrete, d.CLIVersion(), bc.Data.AccessClientID, bc.Data.AccessClientSecret, time.Now())
	files, err := Render(rc)
	if err != nil {
		return err
	}
	return WriteFiles(dir, files)
}

// Destroy implements setup.Persistable.
func (d *Descriptor) Destroy(dir string) error { return Destroy(dir) }

// LoadInputFile implements setup.InputLoader.
func (d *Descriptor) LoadInputFile(path string) (setup.Input, error) {
	in, err := LoadInputFile(path)
	if err != nil {
		return nil, err
	}
	return WrapInput(in), nil
}

// ApplyFlags implements setup.FlagApplier. Mirrors the
// applyFlagOverrides helper in PR 9's setup_bridge.go.
func (d *Descriptor) ApplyFlags(in setup.Input, dir, imageTag string) error {
	concrete, err := UnwrapInput(in)
	if err != nil {
		return err
	}
	if dir != "" {
		concrete.Dir = dir
	}
	if imageTag != "" {
		concrete.ImageTag = imageTag
	}
	return nil
}

// ApplyDefaults implements setup.Defaulter.
func (d *Descriptor) ApplyDefaults(in setup.Input) {
	concrete, err := UnwrapInput(in)
	if err != nil {
		return
	}
	concrete.Defaults(d.CLIVersion())
}

// DefaultDir returns the default `<dir>` for the bridge daemon. The
// cobra generator uses it as the default for the --dir flag when no
// daemon-specific override is registered.
func (d *Descriptor) DefaultDir() string { return DefaultDir }

// NewInput implements setup.InputFactory. Returns an empty, wrapped
// *BridgeSetupInput so the cobra generator can seed it with flag
// values before handing it to Prompt().
func (d *Descriptor) NewInput() setup.Input { return WrapInput(&BridgeSetupInput{}) }

// --- registration ----------------------------------------------------

// singleton is the registered descriptor instance. Exported via
// setup.Get("bridge"); the cobra generator stamps cliVersion via Bind
// at startup.
var singleton = New()

func init() {
	setup.Register(singleton)
}

// Singleton returns the registered descriptor. Used by the cobra
// generator to call Bind() with the CLI version before serving any
// command.
func Singleton() *Descriptor { return singleton }
