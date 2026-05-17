package migrate

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/state"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/wrangler"
)

type fakeRunner struct {
	args   []string
	stdout string
	err    error
}

func (f *fakeRunner) Run(_ context.Context, args ...string) (*wrangler.Result, error) {
	f.args = args
	return &wrangler.Result{Stdout: []byte(f.stdout)}, f.err
}

func TestApplyWith_ParsesAppliedAndLatest(t *testing.T) {
	t.Parallel()
	store := state.Open(filepath.Join(t.TempDir(), ".deploy-state.json"))
	if err := store.Write(&state.Doc{SchemaVersion: state.CurrentSchema}); err != nil {
		t.Fatal(err)
	}
	fr := &fakeRunner{
		stdout: `🚣 Applied 3 migrations: 0019_foo.sql, 0020_bar.sql, 0021_baz.sql
🌀 Mapping SQL input
✅ done
`,
	}
	res, err := ApplyWith(context.Background(), "polaris-email", true, store, fr)
	if err != nil {
		t.Fatalf("ApplyWith: %v", err)
	}
	if res.Applied != 3 {
		t.Errorf("Applied: want 3, got %d", res.Applied)
	}
	if res.Latest != "0021_baz.sql" {
		t.Errorf("Latest: want 0021_baz.sql, got %q", res.Latest)
	}
}

func TestApplyWith_NoMigrationsToApply(t *testing.T) {
	t.Parallel()
	store := state.Open(filepath.Join(t.TempDir(), ".deploy-state.json"))
	if err := store.Write(&state.Doc{SchemaVersion: state.CurrentSchema}); err != nil {
		t.Fatal(err)
	}
	fr := &fakeRunner{stdout: "No migrations to apply!\n"}
	res, err := ApplyWith(context.Background(), "polaris-email", true, store, fr)
	if err != nil {
		t.Fatalf("ApplyWith: %v", err)
	}
	if res.Applied != 0 {
		t.Errorf("Applied: want 0, got %d", res.Applied)
	}
}

func TestApplyWith_PassesRemoteFlag(t *testing.T) {
	t.Parallel()
	store := state.Open(filepath.Join(t.TempDir(), ".deploy-state.json"))
	if err := store.Write(&state.Doc{SchemaVersion: state.CurrentSchema}); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		remote bool
		want   string
	}{
		{"remote", true, "--remote"},
		{"local", false, "--local"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fr := &fakeRunner{stdout: ""}
			_, err := ApplyWith(context.Background(), "polaris-email", tc.remote, store, fr)
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, a := range fr.args {
				if a == tc.want {
					found = true
				}
			}
			if !found {
				t.Errorf("args missing %s: %v", tc.want, fr.args)
			}
		})
	}
}

func TestApplyWith_StampsPhaseOnSuccess(t *testing.T) {
	t.Parallel()
	store := state.Open(filepath.Join(t.TempDir(), ".deploy-state.json"))
	if err := store.Write(&state.Doc{SchemaVersion: state.CurrentSchema}); err != nil {
		t.Fatal(err)
	}
	fr := &fakeRunner{stdout: "🚣 Applied 1 migration: 0019_foo.sql\n"}
	if _, err := ApplyWith(context.Background(), "polaris-email", true, store, fr); err != nil {
		t.Fatal(err)
	}
	doc, err := store.Read()
	if err != nil {
		t.Fatal(err)
	}
	if doc.Phases[PhaseName].CompletedAt.IsZero() {
		t.Error("migrate phase should be stamped on success")
	}
}

func TestApplyWith_RejectsEmptyDBName(t *testing.T) {
	t.Parallel()
	_, err := ApplyWith(context.Background(), "", true, nil, &fakeRunner{})
	if err == nil {
		t.Fatal("want error on empty db name")
	}
}

func TestApplyWith_PropagatesRunnerError(t *testing.T) {
	t.Parallel()
	fr := &fakeRunner{err: errors.New("boom")}
	_, err := ApplyWith(context.Background(), "polaris-email", true, nil, fr)
	if err == nil {
		t.Fatal("want error when runner errors")
	}
	if !strings.Contains(err.Error(), "polaris-email") {
		t.Errorf("error should cite db name: %v", err)
	}
}
