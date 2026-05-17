package setup

import (
	"context"
	"encoding/json"
	"io"
	"testing"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
)

// fakeDaemon is a minimal Daemon for interface-contract tests. It does
// not exercise any platform-specific paths; it only verifies that the
// registry round-trip works and that all interface methods are
// callable.
type fakeDaemon struct {
	name string
}

func (f *fakeDaemon) Name() string  { return f.name }
func (f *fakeDaemon) Short() string { return "fake " + f.name }
func (f *fakeDaemon) Long() string  { return "fake daemon for tests" }

func (f *fakeDaemon) Prompt(initial Input) (Input, error) { return initial, nil }

func (f *fakeDaemon) PreChecks(_ Input) []PreCheck {
	return []PreCheck{{
		Name:     "fake-check",
		Required: true,
		Run: func(_ context.Context) PreCheckResult {
			return PreCheckResult{Status: "pass", Detail: "ok"}
		},
	}}
}

func (f *fakeDaemon) Render(_ Input) ([]File, error) {
	return []File{{Path: "README.md", Contents: []byte("hi"), Mode: 0o644}}, nil
}

func (f *fakeDaemon) PostUpProbes(_ Input) []Probe {
	return []Probe{{
		Name: "fake-probe",
		Run: func(_ context.Context) ProbeResult {
			return ProbeResult{Status: "pass", Detail: "ok"}
		},
	}}
}

func (f *fakeDaemon) SecretPaths() []SecretSpec {
	return []SecretSpec{{Path: "secrets/fake", EnvVar: "FAKE", Rotation: "manual"}}
}

func (f *fakeDaemon) RegistrationFn(_ context.Context, _ *client.Client, _ Input, _ io.Writer) (Credentials, error) {
	return &fakeCredentials{kind: f.name}, nil
}

type fakeCredentials struct{ kind string }

func (c *fakeCredentials) CredentialsKind() string { return c.kind }

// fakeInput is a minimal Input. Used by the contract tests to verify
// the Input interface methods round-trip through Marshal/Unmarshal.
type fakeInput struct {
	ModeStr string `json:"mode"`
	Field   string `json:"field"`
}

func (i *fakeInput) Validate() error             { return nil }
func (i *fakeInput) Marshal() ([]byte, error)    { return json.Marshal(i) }
func (i *fakeInput) Unmarshal(b []byte) error    { return json.Unmarshal(b, i) }
func (i *fakeInput) Mode() string                { return i.ModeStr }

func TestRegistry_RegisterAndGet(t *testing.T) {
	d := &fakeDaemon{name: "test-register-and-get"}
	Register(d)
	t.Cleanup(func() { unregisterForTest(d.Name()) })

	got, ok := Get(d.Name())
	if !ok {
		t.Fatalf("Get(%q) returned ok=false", d.Name())
	}
	if got.Name() != d.Name() {
		t.Fatalf("got name %q, want %q", got.Name(), d.Name())
	}
}

func TestRegistry_DoubleRegisterPanics(t *testing.T) {
	d := &fakeDaemon{name: "test-double-register"}
	Register(d)
	t.Cleanup(func() { unregisterForTest(d.Name()) })

	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected panic on double registration, got nil")
		}
	}()
	Register(d)
}

func TestRegistry_NilPanics(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected panic on nil registration")
		}
	}()
	Register(nil)
}

func TestRegistry_Names_Sorted(t *testing.T) {
	a := &fakeDaemon{name: "z-test-names-sorted"}
	b := &fakeDaemon{name: "a-test-names-sorted"}
	Register(a)
	Register(b)
	t.Cleanup(func() {
		unregisterForTest(a.Name())
		unregisterForTest(b.Name())
	})
	got := Names()
	var aIdx, bIdx int
	for i, n := range got {
		switch n {
		case a.Name():
			aIdx = i
		case b.Name():
			bIdx = i
		}
	}
	if bIdx > aIdx {
		t.Fatalf("Names() not sorted: %v had %q after %q", got, a.Name(), b.Name())
	}
}

func TestDaemon_InterfaceContract(t *testing.T) {
	d := &fakeDaemon{name: "test-contract"}
	in := &fakeInput{ModeStr: "test", Field: "value"}
	ctx := context.Background()

	// Prompt returns the seed unchanged for our fake.
	out, err := d.Prompt(in)
	if err != nil {
		t.Fatalf("Prompt: %v", err)
	}
	if out.Mode() != "test" {
		t.Errorf("Prompt mode = %q want test", out.Mode())
	}

	// PreChecks closure invokes cleanly.
	checks := d.PreChecks(in)
	if len(checks) != 1 || checks[0].Run(ctx).Status != "pass" {
		t.Errorf("PreChecks: unexpected %+v", checks)
	}

	// Render produces files.
	files, err := d.Render(in)
	if err != nil || len(files) != 1 {
		t.Fatalf("Render: %v, files=%+v", err, files)
	}

	// PostUpProbes returns and runs.
	probes := d.PostUpProbes(in)
	if len(probes) != 1 || probes[0].Run(ctx).Status != "pass" {
		t.Errorf("PostUpProbes: unexpected %+v", probes)
	}

	// SecretPaths.
	secrets := d.SecretPaths()
	if len(secrets) != 1 || secrets[0].EnvVar != "FAKE" {
		t.Errorf("SecretPaths: unexpected %+v", secrets)
	}

	// RegistrationFn returns Credentials we can discriminate.
	creds, err := d.RegistrationFn(ctx, nil, in, io.Discard)
	if err != nil {
		t.Fatalf("RegistrationFn: %v", err)
	}
	if creds.CredentialsKind() != d.Name() {
		t.Errorf("CredentialsKind = %q want %q", creds.CredentialsKind(), d.Name())
	}
}

func TestInput_MarshalRoundTrip(t *testing.T) {
	original := &fakeInput{ModeStr: "local", Field: "hello"}
	data, err := original.Marshal()
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	loaded := &fakeInput{}
	if err := loaded.Unmarshal(data); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if loaded.ModeStr != "local" || loaded.Field != "hello" {
		t.Fatalf("round-trip lost data: %+v", loaded)
	}
}
