package provision

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/cfapi"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/plan"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/state"
)

// --- test scaffolding --------------------------------------------------------

// cfFake stands in for the Cloudflare API. It accepts the four create
// endpoints the provisioner hits and returns canned IDs. Tracks call
// counts so tests can assert idempotent re-runs touch zero resources.
type cfFake struct {
	d1Posts     atomic.Int32
	r2Posts     atomic.Int32
	r2Lifecycle atomic.Int32
	kvPosts     atomic.Int32
	queuePosts  atomic.Int32

	// failPath, when non-empty, causes the named path to return 500
	// instead of success. Used to verify failure aborts cleanly.
	failPath string

	srv *httptest.Server
}

func newCFFake(t *testing.T) *cfFake {
	t.Helper()
	f := &cfFake{}
	f.srv = httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *cfFake) handle(w http.ResponseWriter, r *http.Request) {
	if f.failPath != "" && strings.Contains(r.URL.Path, f.failPath) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"success":false,"errors":[{"code":7000,"message":"forced failure"}]}`))
		return
	}

	switch {
	case strings.HasSuffix(r.URL.Path, "/d1/database") && r.Method == http.MethodPost:
		f.d1Posts.Add(1)
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		writeOK(w, map[string]any{"uuid": "db-" + body["name"], "name": body["name"]})
	case strings.HasSuffix(r.URL.Path, "/r2/buckets") && r.Method == http.MethodPost:
		f.r2Posts.Add(1)
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		writeOK(w, map[string]any{
			"name":         body["name"],
			"jurisdiction": r.Header.Get("cf-r2-jurisdiction"),
		})
	case strings.Contains(r.URL.Path, "/r2/buckets/") && strings.HasSuffix(r.URL.Path, "/lifecycle"):
		f.r2Lifecycle.Add(1)
		writeOK(w, nil)
	case strings.HasSuffix(r.URL.Path, "/storage/kv/namespaces") && r.Method == http.MethodPost:
		f.kvPosts.Add(1)
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		writeOK(w, map[string]any{"id": "kv-" + body["title"], "title": body["title"]})
	case strings.HasSuffix(r.URL.Path, "/queues") && r.Method == http.MethodPost:
		f.queuePosts.Add(1)
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		writeOK(w, map[string]any{"queue_id": "q-" + body["queue_name"], "queue_name": body["queue_name"]})
	default:
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"success":false,"errors":[{"code":7000,"message":"unhandled"}]}`))
	}
}

func writeOK(w http.ResponseWriter, result any) {
	b, _ := json.Marshal(map[string]any{
		"success":  true,
		"errors":   []any{},
		"messages": []any{},
		"result":   result,
	})
	_, _ = w.Write(b)
}

func newTestRunnerClient(t *testing.T, f *cfFake) *cfapi.Client {
	t.Helper()
	return cfapi.NewClient(
		"test-token",
		"acc-test",
		cfapi.WithBaseURL(f.srv.URL),
		cfapi.WithRetryBaseDelay(1*time.Millisecond),
	)
}

func newTestStore(t *testing.T) *state.Store {
	t.Helper()
	dir := t.TempDir()
	return state.Open(filepath.Join(dir, ".deploy-state.json"))
}

// --- the actual tests --------------------------------------------------------

func TestApply_HappyPath_AllCreatesRecorded(t *testing.T) {
	t.Parallel()
	f := newCFFake(t)
	client := newTestRunnerClient(t, f)
	store := newTestStore(t)

	desired := plan.Desired()
	p := plan.Diff(desired, &state.Doc{}, plan.Snapshot{})

	if err := Apply(context.Background(), client, store, p, nil); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	doc, err := store.Read()
	if err != nil {
		t.Fatalf("Read state: %v", err)
	}
	// Every desired resource should be recorded.
	if len(doc.D1) != len(desired.D1) {
		t.Errorf("want %d D1 records, got %d", len(desired.D1), len(doc.D1))
	}
	if len(doc.R2) != len(desired.R2) {
		t.Errorf("want %d R2 records, got %d", len(desired.R2), len(doc.R2))
	}
	if len(doc.KV) != len(desired.KV) {
		t.Errorf("want %d KV records, got %d", len(desired.KV), len(doc.KV))
	}
	if len(doc.Queues) != len(desired.Queues) {
		t.Errorf("want %d Queue records, got %d", len(desired.Queues), len(doc.Queues))
	}

	// All records should be Discovered=false (we created them).
	for _, r := range doc.D1 {
		if r.Discovered {
			t.Errorf("D1 %q: Discovered=true on Create path", r.Name)
		}
		if r.ID == "" {
			t.Errorf("D1 %q: empty ID", r.Name)
		}
	}

	// Phase recorded.
	if _, ok := doc.Phases[PhaseName]; !ok {
		t.Errorf("provision phase not recorded; phases=%v", doc.Phases)
	}
	if doc.Phases[PhaseName].CompletedAt.IsZero() {
		t.Error("provision phase CompletedAt is zero")
	}

	// HTTP call counts: one POST per desired resource.
	if got, want := int(f.d1Posts.Load()), len(desired.D1); got != want {
		t.Errorf("D1 POSTs: want %d, got %d", want, got)
	}
	if got, want := int(f.r2Posts.Load()), len(desired.R2); got != want {
		t.Errorf("R2 POSTs: want %d, got %d", want, got)
	}
	if got, want := int(f.r2Lifecycle.Load()), len(desired.R2); got != want {
		t.Errorf("R2 lifecycle PUTs: want %d, got %d", want, got)
	}
	if got, want := int(f.kvPosts.Load()), len(desired.KV); got != want {
		t.Errorf("KV POSTs: want %d, got %d", want, got)
	}
	if got, want := int(f.queuePosts.Load()), len(desired.Queues); got != want {
		t.Errorf("Queue POSTs: want %d, got %d", want, got)
	}
}

func TestApply_Rerun_NoOpWhenAllPresent(t *testing.T) {
	t.Parallel()
	f := newCFFake(t)
	client := newTestRunnerClient(t, f)
	store := newTestStore(t)

	// First pass populates state.
	desired := plan.Desired()
	p1 := plan.Diff(desired, &state.Doc{}, plan.Snapshot{})
	if err := Apply(context.Background(), client, store, p1, nil); err != nil {
		t.Fatalf("first Apply: %v", err)
	}
	postsBefore := f.d1Posts.Load() + f.r2Posts.Load() + f.kvPosts.Load() + f.queuePosts.Load()

	// Second pass: state matches live (we simulate live by re-listing
	// what state holds — equivalent for the diff path).
	doc, _ := store.Read()
	snap := docToSnapshot(doc)
	p2 := plan.Diff(desired, doc, snap)

	if p2.HasCreates() {
		t.Fatalf("re-run plan still has creates: %+v", p2.Creates)
	}
	if err := Apply(context.Background(), client, store, p2, nil); err != nil {
		t.Fatalf("second Apply: %v", err)
	}
	postsAfter := f.d1Posts.Load() + f.r2Posts.Load() + f.kvPosts.Load() + f.queuePosts.Load()
	if postsAfter != postsBefore {
		t.Errorf("re-run made HTTP calls: before=%d after=%d", postsBefore, postsAfter)
	}
}

func TestApply_AdoptPath_NoHTTPCalls(t *testing.T) {
	t.Parallel()
	f := newCFFake(t)
	client := newTestRunnerClient(t, f)
	store := newTestStore(t)

	desired := plan.Desired()
	// Snapshot has every resource; state has none → all Adopt entries.
	snap := plan.Snapshot{}
	for _, d := range desired.D1 {
		snap.D1 = append(snap.D1, plan.LiveResource{ID: "preexisting-" + d.Name, Name: d.Name})
	}
	for _, d := range desired.R2 {
		snap.R2 = append(snap.R2, plan.LiveR2{Name: d.Name, Jurisdiction: d.Jurisdiction})
	}
	for _, d := range desired.KV {
		snap.KV = append(snap.KV, plan.LiveResource{ID: "preexisting-" + d.Title, Name: d.Title})
	}
	for _, d := range desired.Queues {
		snap.Queues = append(snap.Queues, plan.LiveResource{ID: "preexisting-" + d.Name, Name: d.Name})
	}
	p := plan.Diff(desired, &state.Doc{}, snap)
	if len(p.Adopt) == 0 {
		t.Fatal("expected adopt entries")
	}

	if err := Apply(context.Background(), client, store, p, nil); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	// No POSTs on the adopt path.
	total := f.d1Posts.Load() + f.r2Posts.Load() + f.kvPosts.Load() + f.queuePosts.Load() + f.r2Lifecycle.Load()
	if total != 0 {
		t.Errorf("adopt path made %d HTTP calls; expected 0", total)
	}

	doc, _ := store.Read()
	// All records flagged Discovered=true.
	for _, r := range doc.D1 {
		if !r.Discovered {
			t.Errorf("D1 %q: Discovered=false on adopt path", r.Name)
		}
		if !strings.HasPrefix(r.ID, "preexisting-") {
			t.Errorf("D1 %q: adopt should preserve live ID, got %q", r.Name, r.ID)
		}
	}
}

func TestApply_FailureMidRun_StatePersistsProgress(t *testing.T) {
	t.Parallel()
	f := newCFFake(t)
	// Fail when CF receives the KV create. D1 + R2 should succeed and
	// be persisted before the failure.
	f.failPath = "/storage/kv/namespaces"
	client := newTestRunnerClient(t, f)
	store := newTestStore(t)

	desired := plan.Desired()
	p := plan.Diff(desired, &state.Doc{}, plan.Snapshot{})

	err := Apply(context.Background(), client, store, p, nil)
	if err == nil {
		t.Fatal("Apply should have failed at KV step")
	}
	if !strings.Contains(err.Error(), "kv") && !strings.Contains(err.Error(), "polaris-email-nonce") {
		t.Errorf("error should cite kv step, got: %v", err)
	}

	// State must reflect the D1 + R2 creates that succeeded before the
	// failure. That's the resumability guarantee.
	doc, _ := store.Read()
	if len(doc.D1) != len(desired.D1) {
		t.Errorf("D1 progress not persisted: want %d, got %d", len(desired.D1), len(doc.D1))
	}
	if len(doc.R2) != len(desired.R2) {
		t.Errorf("R2 progress not persisted: want %d, got %d", len(desired.R2), len(doc.R2))
	}
	if len(doc.KV) != 0 {
		t.Errorf("KV should be empty on failure, got %d", len(doc.KV))
	}

	// Phase MUST NOT be marked complete.
	if _, ok := doc.Phases[PhaseName]; ok {
		t.Error("provision phase should NOT be marked complete on failure")
	}
}

func TestApply_NilArguments(t *testing.T) {
	t.Parallel()
	f := newCFFake(t)
	client := newTestRunnerClient(t, f)
	store := newTestStore(t)

	if err := Apply(context.Background(), nil, store, &plan.Plan{}, nil); err == nil {
		t.Error("nil client should be rejected")
	}
	if err := Apply(context.Background(), client, nil, &plan.Plan{}, nil); err == nil {
		t.Error("nil store should be rejected")
	}
	if err := Apply(context.Background(), client, store, nil, nil); err == nil {
		t.Error("nil plan should be rejected")
	}
}

func TestApply_ContextCancelled(t *testing.T) {
	t.Parallel()
	f := newCFFake(t)
	client := newTestRunnerClient(t, f)
	store := newTestStore(t)

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // immediately

	desired := plan.Desired()
	p := plan.Diff(desired, &state.Doc{}, plan.Snapshot{})
	err := Apply(ctx, client, store, p, nil)
	if err == nil {
		t.Fatal("cancelled context should abort")
	}
	if !errors.Is(err, context.Canceled) && !strings.Contains(err.Error(), "context canceled") {
		t.Errorf("want context-canceled error, got: %v", err)
	}
}

func TestApply_ReporterReceivesEvents(t *testing.T) {
	t.Parallel()
	f := newCFFake(t)
	client := newTestRunnerClient(t, f)
	store := newTestStore(t)

	rec := &recordingReporter{}
	desired := plan.Desired()
	p := plan.Diff(desired, &state.Doc{}, plan.Snapshot{})

	if err := Apply(context.Background(), client, store, p, rec); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	// Start.total counts the planned Create/Adopt entries before the
	// Logpush sub-step runs (it fires unconditionally at the end).
	wantStartTotal := len(p.Creates)
	// Step / StepDone include the always-on Logpush sub-step, so
	// they're one higher than Start.total. The Logpush sub-step is
	// expected to FAIL in this test (no /logpush/jobs handler on the
	// CF fake) — which is fine; the runner advances the phase even on
	// Logpush failure (observability is non-fatal at provision time).
	wantStepCalls := wantStartTotal + 1
	if rec.startTotal != wantStartTotal {
		t.Errorf("reporter Start total: want %d, got %d", wantStartTotal, rec.startTotal)
	}
	if rec.stepCalls != wantStepCalls {
		t.Errorf("reporter Step calls: want %d, got %d", wantStepCalls, rec.stepCalls)
	}
	if rec.stepDoneCalls != wantStepCalls {
		t.Errorf("reporter StepDone calls: want %d, got %d", wantStepCalls, rec.stepDoneCalls)
	}
	if !rec.doneCalled {
		t.Error("reporter Done not called")
	}
}

type recordingReporter struct {
	startTotal    int
	stepCalls     int
	stepDoneCalls int
	doneCalled    bool
}

func (r *recordingReporter) Start(total int)                { r.startTotal = total }
func (r *recordingReporter) Step(string, string)            { r.stepCalls++ }
func (r *recordingReporter) StepDone(string, string, error) { r.stepDoneCalls++ }
func (r *recordingReporter) Done()                          { r.doneCalled = true }

// docToSnapshot mirrors what cmd/infra_plan.go does to convert a state.Doc into
// a plan.Snapshot — handy for the round-trip test above.
func docToSnapshot(d *state.Doc) plan.Snapshot {
	s := plan.Snapshot{}
	for _, r := range d.D1 {
		s.D1 = append(s.D1, plan.LiveResource{ID: r.ID, Name: r.Name})
	}
	for _, b := range d.R2 {
		s.R2 = append(s.R2, plan.LiveR2{Name: b.Name, Jurisdiction: b.Jurisdiction})
	}
	for _, r := range d.KV {
		s.KV = append(s.KV, plan.LiveResource{ID: r.ID, Name: r.Name})
	}
	for _, r := range d.Queues {
		s.Queues = append(s.Queues, plan.LiveResource{ID: r.ID, Name: r.Name})
	}
	return s
}
