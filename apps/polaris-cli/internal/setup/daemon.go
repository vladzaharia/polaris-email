// Package setup is the root of the polaris-mail setup CLI tree. It
// declares the generic `Daemon` interface that every container-bootstrap
// descriptor (mail-bridge, submission-daemon, ...) implements, plus a
// small thread-safe registry the cobra command generator consumes.
//
// Adding a second daemon is a self-contained change: drop a new
// directory under `internal/setup/daemons/<name>/`, implement the
// interface, register via `init()`, and blank-import the package from
// `internal/setup/cmd/setup.go`. The cobra leaves are generated — no
// hand-wiring per daemon.
package setup

import (
	"context"
	"io"
	"os"
	"time"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
)

// Daemon is the contract every container-bootstrap descriptor (e.g.
// mail-bridge, future submission-daemon) implements. The cobra
// generator in internal/setup/cmd/ consumes this surface to emit one
// `setup <name>` subtree per registered daemon.
//
// Method semantics:
//
//   - Name / Short / Long power the cobra command help text.
//   - Prompt runs the interactive wizard; the returned Input is the
//     finalised, validated payload the rest of the methods consume.
//   - PreChecks returns the list of pre-flight checks for the supplied
//     input. Each PreCheck's Run closure is invoked by the cobra leaf.
//   - Render produces the on-disk artefacts (compose, env, README, ...).
//   - PostUpProbes returns the post-`up` health probes (e.g. TLS dial,
//     greeting check, last-seen heartbeat).
//   - SecretPaths returns the on-disk locations + envvar bindings + the
//     rotation strategy for each secret the daemon manages.
//   - RegistrationFn calls the control-plane to mint creds. The returned
//     Credentials are persisted by the cobra leaf via descriptor-side
//     helpers.
type Daemon interface {
	Name() string
	Short() string
	Long() string

	Prompt(initial Input) (Input, error)
	PreChecks(in Input) []PreCheck
	Render(in Input) ([]File, error)
	PostUpProbes(in Input) []Probe

	SecretPaths() []SecretSpec
	RegistrationFn(ctx context.Context, c *client.Client, in Input, w io.Writer) (Credentials, error)
}

// Input is the operator-supplied + flag-derived payload one Daemon
// consumes. Each concrete daemon defines its own struct type that
// satisfies this interface (see daemons/bridge/input.go for the
// canonical example).
type Input interface {
	// Validate enforces cross-field rules. Returns nil on success.
	Validate() error
	// Marshal serialises the input to JSON for --from-file round-trips
	// and the `.polaris-setup.json` snapshot file.
	Marshal() ([]byte, error)
	// Unmarshal is the inverse of Marshal. Implementations should be
	// tolerant of both JSON and YAML payloads when the format is
	// ambiguous; the cobra leaf hints the payload type via path
	// extension at the call site.
	Unmarshal([]byte) error
	// Mode is the deployment mode label (e.g. "local", "tailscale",
	// "tailnet-only"). Empty when a daemon does not have modes.
	Mode() string
}

// File is one output artefact from Daemon.Render. The cobra leaf writes
// each file under the operator's --dir using AtomicWrite + the supplied
// Mode. Sensitive=true marks files that must land at mode 0600 even if
// Mode says otherwise — the writer treats it as a hard floor.
type File struct {
	Path      string
	Contents  []byte
	Mode      os.FileMode
	Sensitive bool
}

// PreCheck is one pre-flight check the operator can run before any
// destructive action. Required=false marks advisory checks (the leaf
// surfaces them but does not abort on failure).
type PreCheck struct {
	Name        string
	Required    bool
	Description string
	Run         func(ctx context.Context) PreCheckResult
}

// PreCheckResult is the outcome of one PreCheck.Run invocation. Status
// is one of "pass", "warn", "fail"; Detail is operator-facing text; Fix
// is a one-line remediation hint shown alongside Detail.
type PreCheckResult struct {
	Status string
	Detail string
	Fix    string
}

// Probe is one post-up health probe. Timeout bounds the Run closure;
// the leaf wraps it in a derived context.
type Probe struct {
	Name    string
	Timeout time.Duration
	Run     func(ctx context.Context) ProbeResult
}

// ProbeResult is the outcome of one Probe.Run invocation. Status is one
// of "pass", "fail", "skip" (the latter indicates the probe was not
// applicable for the supplied input, e.g. no lookup client wired).
type ProbeResult struct {
	Status string
	Detail string
}

// SecretSpec describes one secret the daemon persists under
// `<dir>/secrets/`. Rotation is one of:
//
//   - "rotate-via-api": mint a fresh value via the control-plane;
//     the daemon calls RegistrationFn again and overwrites the file.
//   - "regen-local": generated locally (e.g. an HMAC key the operator
//     also configures on the control plane).
//   - "manual": operator-supplied (e.g. a mounted PEM bundle).
type SecretSpec struct {
	Path     string
	EnvVar   string
	Rotation string
}

// Credentials is the opaque payload returned by Daemon.RegistrationFn.
// Concrete daemons return a daemon-specific struct embedded in this
// interface; the leaf only forwards it back to the descriptor's
// persistence helper (so this package stays free of cobra/wizard deps).
type Credentials interface {
	// CredentialsKind is a discriminator tag for debug logging. The leaf
	// does not branch on it.
	CredentialsKind() string
}

// --- optional lifecycle interfaces ----------------------------------
//
// Daemons that ship as docker-compose deployments implement Lifecycle
// (up/down/status). Daemons that own on-disk artefacts under <dir>/
// implement Persistable (init dir, persist creds, snapshot, destroy).
// These are split out so a hypothetical non-compose daemon (e.g. a
// systemd unit) can satisfy Daemon without implementing the docker
// lifecycle.

// Lifecycle is the docker-compose lifecycle surface. The cobra
// generator's `up` / `down` / `status` / `upgrade` leaves call these
// methods.
type Lifecycle interface {
	Up(ctx context.Context, in Input, profiles []string, logTo io.Writer) error
	Down(ctx context.Context, in Input, deleteVolumes bool, logTo io.Writer) error
	Status(ctx context.Context, in Input) ([]ContainerStatus, error)
}

// Persistable is the on-disk-artefact surface. The cobra generator's
// `init` / `register` / `destroy` leaves call these methods.
type Persistable interface {
	// InitDir prepares the <dir>/ + <dir>/secrets/ scaffolding. Called
	// before any Render writes happen.
	InitDir(dir string) error
	// WriteFiles writes the rendered files to <dir>/.
	WriteFiles(dir string, files []File) error
	// Persist saves the credentials returned by RegistrationFn under
	// <dir>/secrets/. Returns nothing on success — failures must be
	// fatal (the leaf surfaces them).
	Persist(dir string, in Input, creds Credentials) error
	// Destroy removes the entire <dir>/. The leaf has already
	// confirmed the destructive action with the operator.
	Destroy(dir string) error
}

// ContainerStatus mirrors the minimal compose ps shape the cobra leaf
// renders into a table. Kept here so the cobra generator does not
// reach into platform/.
type ContainerStatus struct {
	Service string
	State   string
	Health  string
	Status  string
}

// FlagBinder is the optional interface a daemon implements when it
// needs the cobra leaves to pass CLI-level configuration (e.g. the
// compiled-in CLI version, which the bridge bakes into the image tag).
// The cobra generator calls Bind() once, before serving any command.
type FlagBinder interface {
	Bind(cliVersion string)
}

// InputLoader is the optional interface a daemon implements when it
// owns the --from-file path. The cobra generator calls LoadInputFile()
// to obtain a setup.Input from the operator-supplied snapshot.
type InputLoader interface {
	LoadInputFile(path string) (Input, error)
}

// FlagApplier is the optional interface a daemon implements when the
// common cobra flags need to mutate the input post-load. The cobra
// generator passes the operator-supplied --dir and --image-tag values
// even when the operator did not change them (Dir defaults to
// "./<name>" via cobra defaults).
type FlagApplier interface {
	ApplyFlags(in Input, dir, imageTag string) error
}

// Defaulter is the optional interface a daemon implements to stamp
// zero-value defaults onto a freshly-loaded input. The cobra generator
// invokes it after the input loads and before Validate.
type Defaulter interface {
	ApplyDefaults(in Input)
}

// DirDefaulter is the optional interface a daemon implements when its
// default project directory differs from "./<name>". The cobra
// generator falls back to "./<name>" when this interface is not
// satisfied.
type DirDefaulter interface {
	DefaultDir() string
}

// Snapshotter is the optional interface a daemon implements to control
// where the input snapshot file lives relative to <dir>. The default
// is "<dir>/.polaris-setup.json".
type Snapshotter interface {
	SnapshotPath(dir string) string
}

// InputFactory is the optional interface a daemon implements to mint a
// fresh, zero-value Input. The cobra generator uses it to seed the
// interactive wizard with operator-supplied --dir / --image-tag flag
// values when no snapshot or --from-file is available.
type InputFactory interface {
	NewInput() Input
}
