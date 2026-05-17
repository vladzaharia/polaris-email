package bridge

import (
	"flag"
	"os"
	"path/filepath"
	"testing"
	"time"
)

var updateGolden = flag.Bool("update-golden", false, "rewrite testdata/render-golden fixtures")

// fixtures returns the canonical render scenarios. ExampleInputs are
// also used by the make compose-examples target to regenerate the
// in-repo apps/mail-bridge/docker-compose.*.yml files (which need
// concrete, generation-time-pinned values).
func fixtures() map[string]*BridgeSetupInput {
	return map[string]*BridgeSetupInput{
		"local-mounted": {
			Mode:          ModeLocal,
			BridgeName:    "polaris-mail-local",
			Environment:   "prod",
			PolarisAPIURL: "https://api.polaris.example.com",
			PublicURL:     "https://mail.example.com",
			TLSSource:     TLSMounted,
			FQDN:          "mail.example.com",
			SMTPSPort:     465,
			IMAPPort:      993,
			WebhookPort:   8080,
			TLSDir:        "./tls",
			ImageTag:      "v0.0.0-test",
		},
		"local-lego": {
			Mode:          ModeLocal,
			BridgeName:    "polaris-mail-local-lego",
			Environment:   "prod",
			PolarisAPIURL: "https://api.polaris.example.com",
			PublicURL:     "https://mail.example.com",
			TLSSource:     TLSLego,
			FQDN:          "mail.example.com",
			SMTPSPort:     465,
			IMAPPort:      993,
			WebhookPort:   8080,
			TLSDir:        "./tls",
			ACMEEmail:     "ops@example.com",
			ImageTag:      "v0.0.0-test",
		},
		"tailscale-sidecar": {
			Mode:          ModeTailscale,
			BridgeName:    "polaris-mail-us-east",
			Environment:   "prod",
			PolarisAPIURL: "https://api.polaris.example.com",
			PublicURL:     "https://polaris-mail-us-east.example.ts.net",
			TLSSource:     TLSTailscaleSidecar,
			FQDN:          "polaris-mail-us-east.example.com",
			SMTPSPort:     465,
			IMAPPort:      993,
			WebhookPort:   8080,
			Region:        "us-east",
			ImageTag:      "v0.0.0-test",
		},
		"tailscale-lego": {
			Mode:          ModeTailscale,
			BridgeName:    "polaris-mail-us-east-lego",
			Environment:   "prod",
			PolarisAPIURL: "https://api.polaris.example.com",
			PublicURL:     "https://polaris-mail-us-east.example.ts.net",
			TLSSource:     TLSLego,
			FQDN:          "polaris-mail-us-east.example.com",
			SMTPSPort:     465,
			IMAPPort:      993,
			WebhookPort:   8080,
			Region:        "us-east",
			ACMEEmail:     "ops@example.com",
			ImageTag:      "v0.0.0-test",
		},
	}
}

// FixedTime is the timestamp baked into goldens.
var fixedTime = time.Date(2026, 5, 16, 12, 0, 0, 0, time.UTC)

func TestRender_Golden(t *testing.T) {
	for name, in := range fixtures() {
		t.Run(name, func(t *testing.T) {
			in.Defaults("v0.0.0-test")
			if err := in.Validate(); err != nil {
				t.Fatalf("fixture invalid: %v", err)
			}
			rc := NewRenderContext(in, "v0.0.0-test", "test-access-id", "test-access-secret", fixedTime)
			files, err := Render(rc)
			if err != nil {
				t.Fatalf("render: %v", err)
			}
			for _, f := range files {
				goldenPath := filepath.Join("testdata", "render-golden", name, f.RelPath)
				if *updateGolden {
					if err := os.MkdirAll(filepath.Dir(goldenPath), 0o755); err != nil {
						t.Fatalf("mkdir: %v", err)
					}
					if err := os.WriteFile(goldenPath, f.Body, 0o644); err != nil {
						t.Fatalf("write golden: %v", err)
					}
					continue
				}
				want, err := os.ReadFile(goldenPath)
				if err != nil {
					t.Fatalf("read golden %s: %v (run `go test -update-golden`)", goldenPath, err)
				}
				if string(want) != string(f.Body) {
					t.Errorf("%s: golden mismatch\n--- want ---\n%s\n--- got ---\n%s",
						goldenPath, string(want), string(f.Body))
				}
			}
		})
	}
}

func TestWriteFiles_AtomicAndPerms(t *testing.T) {
	in := fixtures()["local-mounted"]
	in.Defaults("v0.0.0-test")
	rc := NewRenderContext(in, "v0.0.0-test", "", "", fixedTime)
	files, err := Render(rc)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	dir := t.TempDir()
	if err := WriteFiles(dir, files); err != nil {
		t.Fatalf("write: %v", err)
	}
	// Mode checks.
	for _, f := range files {
		info, err := os.Stat(filepath.Join(dir, f.RelPath))
		if err != nil {
			t.Fatalf("stat %s: %v", f.RelPath, err)
		}
		if got := info.Mode().Perm(); got != f.Mode {
			t.Errorf("%s mode = %#o want %#o", f.RelPath, got, f.Mode)
		}
	}
	// No leftover tempfiles.
	matches, _ := filepath.Glob(filepath.Join(dir, "*.tmp"))
	if len(matches) != 0 {
		t.Fatalf("tempfiles remain: %v", matches)
	}
}
