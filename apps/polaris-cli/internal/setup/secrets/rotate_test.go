package secrets

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/secrets/sources"
)

// fakeArchive records Append calls so the test can assert the OLD
// value was archived before any pushes.
type fakeArchive struct {
	mu    sync.Mutex
	calls []archiveCall
}

type archiveCall struct {
	name     string
	services []string
	value    string
}

func (a *fakeArchive) Append(name string, services []string, value string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.calls = append(a.calls, archiveCall{name, append([]string(nil), services...), value})
	return nil
}

// capturePusher records every push.
type capturePusher struct {
	mu    sync.Mutex
	calls []captureCall
}

type captureCall struct{ svc, name, value string }

func (p *capturePusher) Push(_ context.Context, svc, name, value string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls = append(p.calls, captureCall{svc, name, value})
	return nil
}

// mapSource returns secret name → value.
type mapSource struct{ values map[string]string }

func (m mapSource) Name() string { return "test-map" }
func (m mapSource) Load(_ context.Context, name string) (string, error) {
	return m.values[name], nil
}

func TestRotate_GeneratesNewValueAndPushes(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	rec := NewRecorder(filepath.Join(dir, "secrets.created.json"))
	for _, svc := range []string{"api", "out", "in"} {
		if err := rec.Record(svc, "POLARIS_SECRET_A", "originalvalue1234567890", time.Now()); err != nil {
			t.Fatal(err)
		}
	}

	currentValueB64 := base64.RawStdEncoding.EncodeToString(make([]byte, 32))
	src := mapSource{values: map[string]string{"POLARIS_SECRET_A": currentValueB64}}
	arch := &fakeArchive{}
	pusher := &capturePusher{}

	err := Rotate(context.Background(), "POLARIS_SECRET_A", RotateOptions{
		Sources:  []sources.Source{src},
		Pusher:   pusher,
		Recorder: rec,
		Archive:  arch,
	})
	if err != nil {
		t.Fatalf("Rotate: %v", err)
	}

	if len(arch.calls) != 1 {
		t.Fatalf("want 1 archive call, got %d", len(arch.calls))
	}
	if arch.calls[0].value != currentValueB64 {
		t.Errorf("archive should hold OLD value")
	}
	if len(arch.calls[0].services) != 3 {
		t.Errorf("archive should record all 3 services, got %d", len(arch.calls[0].services))
	}

	if len(pusher.calls) != 3 {
		t.Fatalf("want 3 pushes, got %d", len(pusher.calls))
	}
	pushed := pusher.calls[0].value
	if pushed == currentValueB64 {
		t.Error("rotation pushed the SAME value — generator did not run")
	}
	for _, c := range pusher.calls[1:] {
		if c.value != pushed {
			t.Errorf("all services should receive the same NEW value")
		}
	}
}

func TestRotate_PreservesBase64Format(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	rec := NewRecorder(filepath.Join(dir, "rec.json"))
	_ = rec.Record("api", "X", "ignored", time.Now())

	b64 := base64.RawStdEncoding.EncodeToString(make([]byte, 32))
	src := mapSource{values: map[string]string{"X": b64}}
	pusher := &capturePusher{}
	err := Rotate(context.Background(), "X", RotateOptions{
		Sources:  []sources.Source{src},
		Pusher:   pusher,
		Recorder: rec,
	})
	if err != nil {
		t.Fatal(err)
	}
	newVal := pusher.calls[0].value
	if _, err := base64.RawStdEncoding.DecodeString(newVal); err != nil {
		t.Errorf("rotated base64 value should decode: %v", err)
	}
}

func TestRotate_PreservesHexFormat(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	rec := NewRecorder(filepath.Join(dir, "rec.json"))
	_ = rec.Record("api", "ARGON2_PEPPER", "ignored", time.Now())

	hx := hex.EncodeToString(make([]byte, 32))
	src := mapSource{values: map[string]string{"ARGON2_PEPPER": hx}}
	pusher := &capturePusher{}
	err := Rotate(context.Background(), "ARGON2_PEPPER", RotateOptions{
		Sources:  []sources.Source{src},
		Pusher:   pusher,
		Recorder: rec,
	})
	if err != nil {
		t.Fatal(err)
	}
	newVal := pusher.calls[0].value
	if _, err := hex.DecodeString(newVal); err != nil {
		t.Errorf("rotated hex value should decode: %v", err)
	}
}

func TestRotate_RequiresSources(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	rec := NewRecorder(filepath.Join(dir, "rec.json"))
	err := Rotate(context.Background(), "X", RotateOptions{
		Recorder: rec,
	})
	if err == nil {
		t.Fatal("want error with no sources")
	}
}

func TestRotate_NoCurrentValueFails(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	rec := NewRecorder(filepath.Join(dir, "rec.json"))
	_ = rec.Record("api", "X", "ignored", time.Now())

	src := mapSource{values: map[string]string{}}
	err := Rotate(context.Background(), "X", RotateOptions{
		Sources:  []sources.Source{src},
		Recorder: rec,
	})
	if err == nil {
		t.Fatal("want error when source chain has no current value")
	}
}

func TestRotate_NoRecordedServicesFails(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	rec := NewRecorder(filepath.Join(dir, "rec.json"))
	src := mapSource{values: map[string]string{"X": "val"}}
	err := Rotate(context.Background(), "X", RotateOptions{
		Sources:  []sources.Source{src},
		Recorder: rec,
	})
	if err == nil {
		t.Fatal("want error when no services recorded for the secret")
	}
}

func TestRotate_RecorderUpsertsNewSHA(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	rec := NewRecorder(filepath.Join(dir, "rec.json"))
	_ = rec.Record("api", "X", "oldvalue1234567890", time.Now())
	beforeAll, _ := rec.All()
	oldSHA := beforeAll[0].SHA256

	src := mapSource{values: map[string]string{"X": base64.RawStdEncoding.EncodeToString(make([]byte, 32))}}
	if err := Rotate(context.Background(), "X", RotateOptions{
		Sources:  []sources.Source{src},
		Pusher:   &capturePusher{},
		Recorder: rec,
	}); err != nil {
		t.Fatal(err)
	}

	afterAll, _ := rec.All()
	if len(afterAll) != 1 {
		t.Fatalf("recorder should still hold one row per (svc, name), got %d", len(afterAll))
	}
	if afterAll[0].SHA256 == oldSHA {
		t.Error("recorder SHA should have changed after rotation")
	}
}
