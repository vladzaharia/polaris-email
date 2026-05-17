// Command render-compose-examples re-renders the in-repo example
// compose files under apps/mail-bridge/ from the bridge daemon's Go
// templates. The result is the canonical content for:
//
//   - apps/mail-bridge/docker-compose.local.yml
//   - apps/mail-bridge/docker-compose.tailscale.yml
//
// Invoked via `make -C apps/mail-bridge compose-examples`. CI fails
// (drift gate) on a non-empty git diff after running the target.
//
// The image tag baked into the example files is the CLI version
// known at generation time — operators eyeballing the in-repo examples
// see a real pinned version, not :latest.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/cmds"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/daemons/bridge"
)

func main() {
	outDir := flag.String("out", "apps/mail-bridge", "output directory")
	imageTag := flag.String("image-tag", "", "image tag to pin (defaults to cmds.Version)")
	flag.Parse()

	tag := *imageTag
	if tag == "" {
		tag = cmds.Version
	}

	// Fixed timestamp so the rendered banner is reproducible. Real
	// wizard runs use time.Now(); the in-repo examples are committed
	// artefacts so they need a stable seed.
	fixed := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

	exemplars := []struct {
		out string
		in  *bridge.BridgeSetupInput
	}{
		{
			out: "docker-compose.local.yml",
			in: &bridge.BridgeSetupInput{
				Mode:          bridge.ModeLocal,
				BridgeName:    "polaris-mail-local",
				Environment:   "prod",
				PolarisAPIURL: "https://api.polaris.example.com",
				PublicURL:     "https://mail.example.com",
				TLSSource:     bridge.TLSMounted,
				FQDN:          "mail.example.com",
				ImageTag:      tag,
			},
		},
		{
			out: "docker-compose.tailscale.yml",
			in: &bridge.BridgeSetupInput{
				Mode:          bridge.ModeTailscale,
				BridgeName:    "polaris-mail-us-east",
				Environment:   "prod",
				PolarisAPIURL: "https://api.polaris.example.com",
				PublicURL:     "https://polaris-mail-us-east.example.ts.net",
				TLSSource:     bridge.TLSTailscaleSidecar,
				FQDN:          "polaris-mail-us-east.example.com",
				Region:        "us-east",
				ImageTag:      tag,
			},
		},
	}
	for _, x := range exemplars {
		x.in.Defaults(tag)
		if err := x.in.Validate(); err != nil {
			fail(fmt.Errorf("validate %s: %w", x.out, err))
		}
		rc := bridge.NewRenderContext(x.in, tag, "", "", fixed)
		files, err := bridge.Render(rc)
		if err != nil {
			fail(fmt.Errorf("render %s: %w", x.out, err))
		}
		// Pick the compose file from the rendered set.
		var body []byte
		for _, f := range files {
			if f.RelPath == "docker-compose.yml" {
				body = f.Body
				break
			}
		}
		if body == nil {
			fail(fmt.Errorf("render %s: no docker-compose.yml in output", x.out))
		}
		target := filepath.Join(*outDir, x.out)
		if err := os.WriteFile(target, body, 0o644); err != nil {
			fail(fmt.Errorf("write %s: %w", target, err))
		}
		fmt.Fprintf(os.Stderr, "wrote %s\n", target)
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "error:", err)
	os.Exit(1)
}
