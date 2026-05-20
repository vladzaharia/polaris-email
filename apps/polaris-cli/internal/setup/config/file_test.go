package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoad_ParsesShellQuotedValues(t *testing.T) {
	t.Parallel()
	body := `# comment
CF_ACCOUNT_ID="abc-123"
POLARIS_API_HOSTNAME=api.example.com
CF_API_TOKEN='secret token'
SYNTHETIC_FROM=""

# blank lines and comments ignored
ALERT_WEBHOOK=https://hooks.example.com/abc
`
	c, err := parse(strings.NewReader(body))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if c.CFAccountID != "abc-123" {
		t.Errorf("CFAccountID: %q", c.CFAccountID)
	}
	if c.PolarisAPIHostname != "api.example.com" {
		t.Errorf("PolarisAPIHostname: %q", c.PolarisAPIHostname)
	}
	if c.CFAPIToken != "secret token" {
		t.Errorf("CFAPIToken: %q", c.CFAPIToken)
	}
	if c.SyntheticFrom != "" {
		t.Errorf("SyntheticFrom should be empty: %q", c.SyntheticFrom)
	}
	if c.AlertWebhook != "https://hooks.example.com/abc" {
		t.Errorf("AlertWebhook: %q", c.AlertWebhook)
	}
}

func TestLoad_AcceptsExportPrefix(t *testing.T) {
	t.Parallel()
	body := `export CF_ACCOUNT_ID="abc"
`
	c, err := parse(strings.NewReader(body))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if c.CFAccountID != "abc" {
		t.Errorf("CFAccountID: %q", c.CFAccountID)
	}
}

func TestLoad_MalformedLine(t *testing.T) {
	t.Parallel()
	body := `CF_ACCOUNT_ID=abc
no equals here
`
	if _, err := parse(strings.NewReader(body)); err == nil {
		t.Fatal("expected error on malformed line")
	}
}

func TestSave_AtomicAnd0600(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	path := filepath.Join(dir, ".env.deploy")
	c := &Config{
		CFAccountID:        "acc-1",
		PolarisAPIHostname: "api.example.com",
		CFAPIToken:         `tok"with"quotes`,
	}
	if err := Save(path, c); err != nil {
		t.Fatalf("Save: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("perm: want 0600, got %o", info.Mode().Perm())
	}

	// No leftover tempfile.
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if filepath.Ext(e.Name()) == ".tmp" {
			t.Errorf("orphan tempfile: %s", e.Name())
		}
	}

	// Round-trip
	back, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if back.CFAccountID != c.CFAccountID {
		t.Errorf("CFAccountID round-trip: want %q got %q", c.CFAccountID, back.CFAccountID)
	}
	if back.CFAPIToken != c.CFAPIToken {
		t.Errorf("CFAPIToken round-trip: want %q got %q", c.CFAPIToken, back.CFAPIToken)
	}
}

func TestSave_FieldOrderMatchesShell(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	path := filepath.Join(dir, ".env.deploy")
	c := &Config{CFAccountID: "a", PolarisAPIHostname: "b"}
	if err := Save(path, c); err != nil {
		t.Fatalf("Save: %v", err)
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	// First key emitted must be CF_ACCOUNT_ID (per [FieldOrder]).
	idx := strings.Index(string(body), "\nCF_ACCOUNT_ID=")
	if idx < 0 {
		t.Errorf("CF_ACCOUNT_ID not present:\n%s", string(body))
	}
	// CF_API_TOKEN must come BEFORE CF_ZONE_ID (matches shell order).
	apiIdx := strings.Index(string(body), "\nCF_API_TOKEN=")
	zoneIdx := strings.Index(string(body), "\nCF_ZONE_ID=")
	if apiIdx < 0 || zoneIdx < 0 || apiIdx > zoneIdx {
		t.Errorf("CF_API_TOKEN should appear before CF_ZONE_ID")
	}
}

func TestLoadOrDefault_MissingReturnsBlank(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	c, err := LoadOrDefault(filepath.Join(dir, "nope.env"))
	if err != nil {
		t.Fatalf("LoadOrDefault: %v", err)
	}
	if c == nil {
		t.Fatal("LoadOrDefault returned nil on missing file")
	}
	if c.CFAccountID != "" {
		t.Errorf("blank config should have empty fields, got %q", c.CFAccountID)
	}
}

func TestShellEscape_RoundTripsThroughBash(t *testing.T) {
	t.Parallel()
	// Round-trip values that have caused issues historically: shell
	// metacharacters in B2 secrets, embedded quotes, dollar signs.
	cases := []string{
		`simple`,
		`with spaces`,
		`with "double" quotes`,
		`with 'single' quotes`,
		`with $variable`,
		"with `backticks`",
		`with \backslashes`,
		`+/=base64==`,
	}
	dir := t.TempDir()
	for i, in := range cases {
		c := &Config{CFAccountID: "x", PolarisAPIHostname: "y", CFAPIToken: in}
		path := filepath.Join(dir, "env-")
		path = path + tName(i)
		if err := Save(path, c); err != nil {
			t.Fatalf("Save %q: %v", in, err)
		}
		back, err := Load(path)
		if err != nil {
			t.Fatalf("Load %q: %v", in, err)
		}
		if back.CFAPIToken != in {
			t.Errorf("round-trip mismatch:\n  in:  %q\n  out: %q", in, back.CFAPIToken)
		}
	}
}

// tName returns a filename-safe string for the test loop.
func tName(i int) string {
	return string(rune('a' + i))
}
