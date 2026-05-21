package wranglercfg

import (
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"

	"github.com/tailscale/hujson"
)

// -update regenerates the golden files in testdata/golden/. Pass with
// `go test ./internal/setup/wranglercfg -run TestRender_Goldens -update`.
var updateGoldens = flag.Bool("update", false, "regenerate golden files in testdata/")

// TestRender_Goldens renders each of the four service templates from
// the live repo and diffs them against checked-in goldens. This catches
// any accidental drift in either the template syntax or the renderer.
//
// The four service template paths are joined from the polaris-cli
// package up to repo root; if the layout ever changes the test fails
// loudly rather than silently rendering nothing.
func TestRender_Goldens(t *testing.T) {
	repoRoot := findRepoRoot(t)
	in := fullyPopulatedInputs()

	cases := []struct {
		name     string
		template string
		golden   string
	}{
		{"api", "services/api/wrangler.local.template.jsonc", "testdata/golden/api.jsonc"},
		{"in", "services/in/wrangler.local.template.jsonc", "testdata/golden/in.jsonc"},
		{"out", "services/out/wrangler.local.template.jsonc", "testdata/golden/out.jsonc"},
		{"panel", "apps/panel/wrangler.local.template.jsonc", "testdata/golden/panel.jsonc"},
		{"cli-installer", "apps/cli-installer/wrangler.local.template.jsonc", "testdata/golden/cli-installer.jsonc"},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			tpl, err := os.ReadFile(filepath.Join(repoRoot, tc.template))
			if err != nil {
				t.Fatalf("read template %s: %v", tc.template, err)
			}
			got, err := Render(tpl, in)
			if err != nil {
				t.Fatalf("Render: %v", err)
			}

			// Sanity: rendered output must be valid JSONC. We pass
			// a copy to hujson.Standardize because hujson.Parse
			// aliases the input buffer (see hujson docs) and
			// Standardize would otherwise mutate `got` in place,
			// replacing comments with whitespace — exactly the bug
			// the rewrite is trying to AVOID.
			parseCopy := append([]byte(nil), got...)
			if _, err := hujson.Parse(parseCopy); err != nil {
				t.Fatalf("rendered output is not valid JSONC: %v\n%s", err, got)
			}
			stdCopy := append([]byte(nil), got...)
			std, err := hujson.Standardize(stdCopy)
			if err != nil {
				t.Fatalf("rendered output cannot be Standardize'd: %v\n%s", err, got)
			}
			var v map[string]any
			if err := json.Unmarshal(std, &v); err != nil {
				t.Fatalf("standardized output is not valid JSON: %v\n%s", err, std)
			}

			goldenPath := filepath.Join("testdata", "golden", tc.name+".jsonc")
			if *updateGoldens {
				if err := os.MkdirAll(filepath.Dir(goldenPath), 0o755); err != nil {
					t.Fatalf("mkdir: %v", err)
				}
				if err := os.WriteFile(goldenPath, got, 0o644); err != nil {
					t.Fatalf("write golden: %v", err)
				}
				return
			}
			want, err := os.ReadFile(goldenPath)
			if err != nil {
				t.Fatalf("read golden %s: %v (regenerate with -update)", goldenPath, err)
			}
			if string(got) != string(want) {
				t.Errorf("render drift for %s — regenerate with `go test -run TestRender_Goldens -update`\n--- want ---\n%s\n--- got ---\n%s",
					tc.name, want, got)
			}
		})
	}
}

// findRepoRoot walks up from the test cwd looking for the workspace
// pnpm-workspace.yaml file, which marks the polaris-mail repo root.
// The Go test cwd is the package dir, which is several levels down.
func findRepoRoot(t *testing.T) string {
	t.Helper()
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd: %v", err)
	}
	for dir := cwd; ; {
		if _, err := os.Stat(filepath.Join(dir, "pnpm-workspace.yaml")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("repo root not found from %s", cwd)
		}
		dir = parent
	}
}
