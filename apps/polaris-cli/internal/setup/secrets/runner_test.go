package secrets

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/secrets/sources"
)

// captureReporter records every Step/StepDone call so tests can assert
// ordering + count.
type captureReporter struct {
	mu     sync.Mutex
	starts int
	steps  []string
	done   []string
	errs   []string
}

func (c *captureReporter) Start(int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.starts++
}
func (c *captureReporter) Step(name, svc string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.steps = append(c.steps, svc+"/"+name)
}
func (c *captureReporter) StepDone(name, svc string, err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.done = append(c.done, svc+"/"+name)
	if err != nil {
		c.errs = append(c.errs, svc+"/"+name+": "+err.Error())
	}
}
func (c *captureReporter) Done() {}

// stubPusher records every push for assertion. failOn is a set of
// "svc/name" tuples that should error.
type stubPusher struct {
	mu      sync.Mutex
	calls   []string
	values  map[string]string
	failOn  map[string]bool
	failErr error
}

func newStubPusher() *stubPusher {
	return &stubPusher{
		values:  map[string]string{},
		failOn:  map[string]bool{},
		failErr: errors.New("stub: push failed"),
	}
}

func (s *stubPusher) Push(_ context.Context, svc, name, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := svc + "/" + name
	if s.failOn[key] {
		return s.failErr
	}
	s.calls = append(s.calls, key)
	s.values[key] = value
	return nil
}

func TestSeed_GeneratesAndPushesEverywhere(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "secrets.created.json")
	rec := NewRecorder(path)
	push := newStubPusher()
	rep := &captureReporter{}

	specs := []Spec{
		{
			Name:      "POLARIS_SECRET_A",
			Services:  []string{"api", "out", "in", "panel"},
			Generator: func() (string, error) { return "MASTER", nil },
		},
		{
			Name:      "ARGON2_PEPPER",
			Services:  []string{"api"},
			Generator: func() (string, error) { return "PEPPER", nil },
		},
	}
	out, err := Seed(context.Background(), specs, nil, push, rec, rep)
	if err != nil {
		t.Fatalf("Seed: %v", err)
	}
	if out["POLARIS_SECRET_A"] != "MASTER" {
		t.Errorf("returned map missing POLARIS_SECRET_A: %v", out)
	}
	if out["ARGON2_PEPPER"] != "PEPPER" {
		t.Errorf("returned map missing ARGON2_PEPPER: %v", out)
	}
	if len(push.calls) != 5 {
		t.Errorf("want 5 pushes, got %d: %v", len(push.calls), push.calls)
	}
	for _, svc := range []string{"api", "out", "in", "panel"} {
		if push.values[svc+"/POLARIS_SECRET_A"] != "MASTER" {
			t.Errorf("missing push to %s/POLARIS_SECRET_A", svc)
		}
	}
}

func TestSeed_SourcePrecedenceWinsOverGenerator(t *testing.T) {
	t.Parallel()
	rec := NewRecorder(filepath.Join(t.TempDir(), "s.json"))
	push := newStubPusher()
	src := sources.NewEnvSource(map[string]string{
		"OIDC_CLIENT_SECRET": "from-env",
	})
	specs := []Spec{
		{
			Name:     "OIDC_CLIENT_SECRET",
			Services: []string{"panel"},
			// Generator should NOT be consulted because env wins.
			Generator: func() (string, error) { return "GENERATED", nil },
		},
	}
	out, err := Seed(context.Background(), specs, []sources.Source{src}, push, rec, &captureReporter{})
	if err != nil {
		t.Fatalf("Seed: %v", err)
	}
	if push.values["panel/OIDC_CLIENT_SECRET"] != "from-env" {
		t.Errorf("env-source value should win: got %q", push.values["panel/OIDC_CLIENT_SECRET"])
	}
	// Source-resolved values are NOT in the returned map — only generated ones.
	if _, ok := out["OIDC_CLIENT_SECRET"]; ok {
		t.Errorf("source-resolved values should not leak into returned map")
	}
}

func TestSeed_OptionalSkippedWhenNoSourceAndNoGenerator(t *testing.T) {
	t.Parallel()
	rec := NewRecorder(filepath.Join(t.TempDir(), "s.json"))
	push := newStubPusher()
	specs := []Spec{
		{
			Name:     "OIDC_CLIENT_SECRET",
			Services: []string{"panel"},
			Optional: true,
		},
	}
	_, err := Seed(context.Background(), specs, nil, push, rec, &captureReporter{})
	if err != nil {
		t.Fatalf("Seed should not error on optional skip: %v", err)
	}
	if len(push.calls) != 0 {
		t.Errorf("optional skip should not push: %v", push.calls)
	}
}

func TestSeed_PartialFailureKeepsGoingThenErrors(t *testing.T) {
	t.Parallel()
	rec := NewRecorder(filepath.Join(t.TempDir(), "s.json"))
	push := newStubPusher()
	push.failOn["out/POLARIS_SECRET_A"] = true

	specs := []Spec{
		{
			Name:      "POLARIS_SECRET_A",
			Services:  []string{"api", "out", "in", "panel"},
			Generator: func() (string, error) { return "MASTER", nil },
		},
	}
	out, err := Seed(context.Background(), specs, nil, push, rec, &captureReporter{})
	if err == nil {
		t.Fatal("Seed should return aggregated error")
	}
	if !strings.Contains(err.Error(), "out/POLARIS_SECRET_A") {
		t.Errorf("error should cite the failure: %v", err)
	}
	// We DID return the generated value (caller may still need it for downstream).
	if out["POLARIS_SECRET_A"] != "MASTER" {
		t.Errorf("returned map should still hold the generated value: %v", out)
	}
	// api/in/panel should still have landed.
	for _, svc := range []string{"api", "in", "panel"} {
		if push.values[svc+"/POLARIS_SECRET_A"] != "MASTER" {
			t.Errorf("missing push to %s after partial failure", svc)
		}
	}
}

func TestSeed_RecorderDedupesAcrossRuns(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "s.json")
	rec := NewRecorder(path)
	push := newStubPusher()
	specs := []Spec{
		{
			Name:      "POLARIS_SECRET_A",
			Services:  []string{"api"},
			Generator: func() (string, error) { return "MASTER", nil },
		},
	}
	if _, err := Seed(context.Background(), specs, nil, push, rec, &captureReporter{}); err != nil {
		t.Fatal(err)
	}
	if len(push.calls) != 1 {
		t.Fatalf("first run: want 1 push, got %d", len(push.calls))
	}
	// Second run: recorder reports Has=true → no push.
	push2 := newStubPusher()
	if _, err := Seed(context.Background(), specs, nil, push2, rec, &captureReporter{}); err != nil {
		t.Fatal(err)
	}
	if len(push2.calls) != 0 {
		t.Errorf("second run should skip already-recorded: got %v", push2.calls)
	}
}

func TestSeed_CachesSourceValueAcrossServices(t *testing.T) {
	t.Parallel()
	rec := NewRecorder(filepath.Join(t.TempDir(), "s.json"))
	push := newStubPusher()
	var loads int
	src := &countingSource{
		fn: func(_ context.Context, name string) (string, error) {
			loads++
			if name == "POLARIS_SECRET_A" {
				return "CACHED", nil
			}
			return "", nil
		},
	}
	specs := []Spec{
		{
			Name:     "POLARIS_SECRET_A",
			Services: []string{"api", "out", "in", "panel"},
			// No generator — must come from source.
		},
	}
	if _, err := Seed(context.Background(), specs, []sources.Source{src}, push, rec, &captureReporter{}); err != nil {
		t.Fatal(err)
	}
	if loads != 1 {
		t.Errorf("source should be consulted once per secret name, got %d loads", loads)
	}
}

type countingSource struct {
	fn func(ctx context.Context, name string) (string, error)
}

func (c *countingSource) Name() string { return "counting" }
func (c *countingSource) Load(ctx context.Context, name string) (string, error) {
	return c.fn(ctx, name)
}
