package rollback

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/secrets"
)

// recordingPusher captures every (svc, name, value) push for assertions.
type recordingPusher struct {
	mu       sync.Mutex
	calls    []recordCall
	failOnce map[string]error
}

type recordCall struct{ svc, name, value string }

func (p *recordingPusher) Push(_ context.Context, svc, name, value string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls = append(p.calls, recordCall{svc, name, value})
	if p.failOnce != nil {
		if err, ok := p.failOnce[svc]; ok {
			delete(p.failOnce, svc)
			return err
		}
	}
	return nil
}

func TestRollbackSecret_RepushesToRecordedServices(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	arch := NewArchive(filepath.Join(dir, "archive.json"))
	if err := arch.Append("POLARIS_SECRET_A", []string{"api", "out", "in"}, "old-value"); err != nil {
		t.Fatal(err)
	}
	pusher := &recordingPusher{}
	err := RollbackSecret(context.Background(), "POLARIS_SECRET_A", SecretOptions{
		Archive: arch,
		Pusher:  pusher,
	})
	if err != nil {
		t.Fatalf("RollbackSecret: %v", err)
	}
	if len(pusher.calls) != 3 {
		t.Fatalf("want 3 pushes, got %d: %+v", len(pusher.calls), pusher.calls)
	}
	for _, c := range pusher.calls {
		if c.value != "old-value" {
			t.Errorf("expected old value pushed, got %q for %s/%s", c.value, c.svc, c.name)
		}
		if c.name != "POLARIS_SECRET_A" {
			t.Errorf("name: got %q", c.name)
		}
	}
}

func TestRollbackSecret_NoArchive_Errors(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	arch := NewArchive(filepath.Join(dir, "archive.json"))
	err := RollbackSecret(context.Background(), "DOES_NOT_EXIST", SecretOptions{
		Archive: arch,
		Pusher:  &recordingPusher{},
	})
	if err == nil {
		t.Fatal("want error for missing archive entry")
	}
}

func TestRollbackSecret_PartialFailureReported(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	arch := NewArchive(filepath.Join(dir, "archive.json"))
	_ = arch.Append("X", []string{"api", "out"}, "v")

	p := &recordingPusher{failOnce: map[string]error{"out": errors.New("boom")}}
	err := RollbackSecret(context.Background(), "X", SecretOptions{
		Archive: arch,
		Pusher:  p,
	})
	if err == nil {
		t.Fatal("want error on partial failure")
	}
	if len(p.calls) != 2 {
		t.Errorf("partial failure should still attempt every service, got %d calls", len(p.calls))
	}
}

func TestRollbackSecret_EmptyName(t *testing.T) {
	t.Parallel()
	err := RollbackSecret(context.Background(), "", SecretOptions{Archive: NewArchive(""), Pusher: &recordingPusher{}})
	if err == nil {
		t.Fatal("want error on empty name")
	}
}

func TestRollbackSecret_Reporter(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	arch := NewArchive(filepath.Join(dir, "archive.json"))
	_ = arch.Append("Y", []string{"api"}, "v")

	rep := &countingReporter{}
	err := RollbackSecret(context.Background(), "Y", SecretOptions{
		Archive:  arch,
		Pusher:   &recordingPusher{},
		Reporter: rep,
	})
	if err != nil {
		t.Fatal(err)
	}
	if rep.started != 1 || rep.steps != 1 || rep.done != 1 {
		t.Errorf("reporter calls: start=%d step=%d done=%d", rep.started, rep.steps, rep.done)
	}
}

type countingReporter struct {
	started   int
	steps     int
	stepsDone int
	done      int
}

func (r *countingReporter) Start(int)                      { r.started++ }
func (r *countingReporter) Step(string, string)            { r.steps++ }
func (r *countingReporter) StepDone(string, string, error) { r.stepsDone++ }
func (r *countingReporter) Done()                          { r.done++ }

var _ secrets.Reporter = (*countingReporter)(nil)
