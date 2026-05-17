//go:build integration

// Integration tests run against a real Cloudflare account. Skipped
// unless CF_API_TOKEN and CF_TEST_ACCOUNT_ID are set. Invoke with:
//
//	go test -tags=integration -count=1 ./internal/setup/provision/
//
// CI does NOT run this build tag by default — only operator-initiated
// integration sweeps should hit a real account.
//
// The test creates the standard polaris-email desired state in a
// scratch directory. It does NOT delete the resources afterwards —
// operators are expected to clean up via the dashboard or `setup
// infra rollback` (PR 13).

package provision

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/cfapi"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/plan"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/state"
)

func TestApply_RealCloudflare(t *testing.T) {
	token := os.Getenv("CF_API_TOKEN")
	acct := os.Getenv("CF_TEST_ACCOUNT_ID")
	if token == "" || acct == "" {
		t.Skip("CF_API_TOKEN + CF_TEST_ACCOUNT_ID not set; skipping integration test")
	}

	client := cfapi.NewClient(token, acct)
	store := state.Open(filepath.Join(t.TempDir(), ".deploy-state.json"))

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	// Snapshot live to compute the diff. (The plan command does the
	// same thing.)
	snap, err := liveSnapshot(ctx, client)
	if err != nil {
		t.Fatalf("snapshot live: %v", err)
	}
	p := plan.Diff(plan.Desired(), &state.Doc{}, snap)

	t.Logf("plan: %d creates, %d adopts, %d skips", len(p.Creates), len(p.Adopt), len(p.Skips))

	if err := Apply(ctx, client, store, p, NewPlainReporter(os.Stdout)); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	// Re-run should be a no-op (HasCreates() == false against fresh
	// state + live).
	doc, err := store.Read()
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if _, ok := doc.Phases[PhaseName]; !ok {
		t.Error("provision phase not marked complete")
	}
}

// liveSnapshot is duplicated from cmd/infra_plan.go to keep this test
// self-contained. If the shape grows, factor a shared helper into
// cfapi/snapshot.go.
func liveSnapshot(ctx context.Context, c *cfapi.Client) (plan.Snapshot, error) {
	snap := plan.Snapshot{}
	dbs, err := c.ListDatabases(ctx)
	if err != nil {
		return snap, err
	}
	for _, d := range dbs {
		snap.D1 = append(snap.D1, plan.LiveResource{ID: d.UUID, Name: d.Name})
	}
	for _, jur := range []string{"", "eu"} {
		buckets, err := c.ListBuckets(ctx, jur)
		if err != nil {
			if jur != "" && cfapi.IsNotFound(err) {
				continue
			}
			return snap, err
		}
		for _, b := range buckets {
			snap.R2 = append(snap.R2, plan.LiveR2{Name: b.Name, Jurisdiction: b.Jurisdiction})
		}
	}
	ns, err := c.ListNamespaces(ctx)
	if err != nil {
		return snap, err
	}
	for _, n := range ns {
		snap.KV = append(snap.KV, plan.LiveResource{ID: n.ID, Name: n.Title})
	}
	qs, err := c.ListQueues(ctx)
	if err != nil {
		return snap, err
	}
	for _, q := range qs {
		snap.Queues = append(snap.Queues, plan.LiveResource{ID: q.QueueID, Name: q.QueueName})
	}
	return snap, nil
}
