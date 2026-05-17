package bridge

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/platform"
)

// DefaultDir is the default project directory the wizard creates.
const DefaultDir = "./polaris-bridge"

// InitOptions controls Init().
type InitOptions struct {
	// CLIVersion stamps the image tag default + README banner.
	CLIVersion string
	// AccessClientID/Secret are baked into the rendered .env. Pass
	// empty strings when initialising before registration.
	AccessClientID     string
	AccessClientSecret string
	// Now is the timestamp baked into README.GeneratedAt; tests pin
	// it for deterministic output. Zero value → time.Now().
	Now time.Time
}

// Init renders + writes the compose / .env / bridge.toml / README into
// `in.Dir`. Idempotent: re-running on an existing dir overwrites the
// rendered files but leaves <dir>/secrets/ alone.
func Init(in *BridgeSetupInput, opts InitOptions) ([]RenderedFile, error) {
	if err := in.Validate(); err != nil {
		return nil, err
	}
	dir := in.Dir
	if dir == "" {
		dir = DefaultDir
	}
	if err := platform.EnsureDir(dir, 0o750); err != nil {
		return nil, err
	}
	// secrets/ must be 0700 even if it does not yet exist.
	if err := platform.EnsureDir(filepath.Join(dir, "secrets"), 0o700); err != nil {
		return nil, err
	}
	if err := platform.RejectWorldReadableDir(dir); err != nil {
		return nil, err
	}
	now := opts.Now
	if now.IsZero() {
		now = time.Now()
	}
	rc := NewRenderContext(in, opts.CLIVersion, opts.AccessClientID, opts.AccessClientSecret, now)
	files, err := Render(rc)
	if err != nil {
		return nil, err
	}
	if err := WriteFiles(dir, files); err != nil {
		return nil, err
	}
	return files, nil
}

// UpOptions controls Up().
type UpOptions struct {
	Docker   *platform.Docker
	Profiles []string // e.g. ["lego"]
	// LogTo is where pull/up stdout is teed to (operator visibility).
	LogTo io.Writer
}

// Up runs `docker compose pull && docker compose up -d` in
// <in.Dir>. The caller is responsible for invoking Init first.
func Up(ctx context.Context, in *BridgeSetupInput, opts UpOptions) error {
	if in.Dir == "" {
		return fmt.Errorf("bridge: in.Dir is required")
	}
	if opts.Docker == nil {
		opts.Docker = platform.NewDocker()
	}
	if opts.LogTo == nil {
		opts.LogTo = io.Discard
	}
	pulled, err := opts.Docker.ComposePull(ctx, in.Dir)
	if err != nil {
		_, _ = opts.LogTo.Write(pulled)
		return fmt.Errorf("docker compose pull: %w", err)
	}
	_, _ = opts.LogTo.Write(pulled)
	upOut, err := opts.Docker.ComposeUp(ctx, in.Dir, opts.Profiles...)
	if err != nil {
		_, _ = opts.LogTo.Write(upOut)
		return fmt.Errorf("docker compose up: %w", err)
	}
	_, _ = opts.LogTo.Write(upOut)
	return nil
}

// Down runs `docker compose down` in <in.Dir>. The volumes flag wipes
// bridge-data volumes — operator-confirmed destructive action only.
func Down(ctx context.Context, in *BridgeSetupInput, deleteVolumes bool, d *platform.Docker) ([]byte, error) {
	if in.Dir == "" {
		return nil, fmt.Errorf("bridge: in.Dir is required")
	}
	if d == nil {
		d = platform.NewDocker()
	}
	return d.ComposeDown(ctx, in.Dir, deleteVolumes)
}

// Status returns the compose project's container summary.
func Status(ctx context.Context, dir string, d *platform.Docker) ([]platform.ContainerStatus, error) {
	if d == nil {
		d = platform.NewDocker()
	}
	return d.ComposePS(ctx, dir)
}

// Destroy removes <dir>/. The caller MUST have confirmed via a name
// echo or `--yes`. The secrets/ files are removed too.
func Destroy(dir string) error {
	if dir == "" {
		return fmt.Errorf("bridge: dir is required")
	}
	// Refuse to recursively remove anything that does not look like a
	// polaris-bridge project — i.e. must contain docker-compose.yml.
	if _, err := os.Stat(filepath.Join(dir, "docker-compose.yml")); err != nil {
		return fmt.Errorf("refusing to destroy %s — not a polaris-bridge project (no docker-compose.yml)", dir)
	}
	return os.RemoveAll(dir)
}
