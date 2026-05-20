package plan

import (
	"testing"
	"time"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/state"
)

func TestDiff_AllMissing_EmptyStateAndSnapshot(t *testing.T) {
	t.Parallel()
	d := Desired()
	got := Diff(d, &state.Doc{}, Snapshot{})

	wantCreates := len(d.D1) + len(d.R2) + len(d.KV) + len(d.Queues)
	if len(got.Creates) != wantCreates {
		t.Errorf("want %d Creates, got %d", wantCreates, len(got.Creates))
	}
	if len(got.Skips) != 0 {
		t.Errorf("want 0 Skips, got %d", len(got.Skips))
	}
	if len(got.Adopt) != 0 {
		t.Errorf("want 0 Adopt, got %d", len(got.Adopt))
	}
	if len(got.Drift) != 0 {
		t.Errorf("want 0 Drift, got %d", len(got.Drift))
	}

	// Sort order: D1, R2, KV, Queues — first entry must be D1.
	if got.Creates[0].Kind != KindD1 {
		t.Errorf("want D1 first, got %s", got.Creates[0].Kind)
	}
}

func TestDiff_NilObserved_TreatsAsEmpty(t *testing.T) {
	t.Parallel()
	d := Desired()
	got := Diff(d, nil, Snapshot{})
	if !got.HasCreates() {
		t.Error("nil observed should produce Creates for everything")
	}
}

func TestDiff_AllPresent_AllSkip(t *testing.T) {
	t.Parallel()
	d := Desired()
	doc := buildFullStateDoc(d, time.Now().UTC())
	snap := buildFullSnapshot(d)

	got := Diff(d, doc, snap)
	if len(got.Creates) != 0 {
		t.Errorf("want 0 Creates, got %d", len(got.Creates))
	}
	if len(got.Adopt) != 0 {
		t.Errorf("want 0 Adopt, got %d", len(got.Adopt))
	}
	if len(got.Drift) != 0 {
		t.Errorf("want 0 Drift, got %d", len(got.Drift))
	}
	wantSkip := len(d.D1) + len(d.R2) + len(d.KV) + len(d.Queues)
	if len(got.Skips) != wantSkip {
		t.Errorf("want %d Skips, got %d", wantSkip, len(got.Skips))
	}
}

func TestDiff_PartialState_MixedCreatesAndSkips(t *testing.T) {
	t.Parallel()
	d := Desired()
	// State + live have D1 and KV (one entry each) but nothing else.
	doc := &state.Doc{
		D1: map[string]state.Resource{
			"polaris-email": {ID: "db-1", Name: "polaris-email"},
		},
		KV: map[string]state.Resource{
			"polaris-email-nonce": {ID: "kv-1", Name: "polaris-email-nonce"},
		},
	}
	snap := Snapshot{
		D1: []LiveResource{{ID: "db-1", Name: "polaris-email"}},
		KV: []LiveResource{{ID: "kv-1", Name: "polaris-email-nonce"}},
	}

	got := Diff(d, doc, snap)
	if len(got.Skips) != 2 {
		t.Errorf("want 2 Skips, got %d", len(got.Skips))
	}
	// Everything else (R2 + 4 KV + 5 queues) should be Creates.
	wantCreates := len(d.R2) + (len(d.KV) - 1) + len(d.Queues)
	if len(got.Creates) != wantCreates {
		t.Errorf("want %d Creates, got %d", wantCreates, len(got.Creates))
	}
}

func TestDiff_LiveButNoState_AdoptPath(t *testing.T) {
	t.Parallel()
	d := Desired()
	// State is empty; snapshot has every desired resource.
	snap := buildFullSnapshot(d)

	got := Diff(d, &state.Doc{}, snap)
	wantAdopt := len(d.D1) + len(d.R2) + len(d.KV) + len(d.Queues)
	if len(got.Adopt) != wantAdopt {
		t.Errorf("want %d Adopt, got %d", wantAdopt, len(got.Adopt))
	}
	if len(got.Creates) != 0 {
		t.Errorf("want 0 Creates, got %d", len(got.Creates))
	}
	if len(got.Skips) != 0 {
		t.Errorf("want 0 Skips, got %d", len(got.Skips))
	}

	// Adopt entries must carry the LiveID so the provisioner can record
	// without re-listing.
	for _, e := range got.Adopt {
		if e.Kind == KindR2 {
			continue // R2 has no separate ID
		}
		if e.LiveID == "" {
			t.Errorf("adopt entry %q has empty LiveID", e.Name)
		}
	}
}

func TestDiff_StateButNoLive_DriftPath(t *testing.T) {
	t.Parallel()
	d := Desired()
	// State claims polaris-email-nonce + polaris-email-fanout exist;
	// live snapshot says they don't.
	doc := &state.Doc{
		KV: map[string]state.Resource{
			"polaris-email-nonce": {ID: "kv-stale", Name: "polaris-email-nonce"},
		},
		Queues: map[string]state.Resource{
			"polaris-email-fanout": {ID: "q-stale", Name: "polaris-email-fanout"},
		},
	}
	snap := Snapshot{} // empty

	got := Diff(d, doc, snap)
	if len(got.Drift) != 2 {
		t.Errorf("want 2 Drift entries, got %d", len(got.Drift))
		for _, e := range got.Drift {
			t.Logf("  drift: %+v", e)
		}
	}
	// Drift entries preserve the stale state ID for operators to copy.
	for _, e := range got.Drift {
		if e.StateID == "" {
			t.Errorf("drift entry %q must keep StateID for rollback", e.Name)
		}
	}
	// All-undesired-and-missing-but-in-state-only items are *not* Drift.
	if !got.HasDrift() {
		t.Error("HasDrift should report true")
	}
}

func TestDiff_StateOnlyForUndesired_NotDrift(t *testing.T) {
	t.Parallel()
	// A KV namespace that was removed from Desired() but still lingers
	// in state should not show up as Drift — it's just vestigial.
	d := &DesiredState{
		KV: []DesiredKV{
			{Title: "polaris-email-nonce"},
		},
	}
	doc := &state.Doc{
		KV: map[string]state.Resource{
			"polaris-email-vestigial": {ID: "kv-old", Name: "polaris-email-vestigial"},
		},
	}
	got := Diff(d, doc, Snapshot{})
	if len(got.Drift) != 0 {
		t.Errorf("vestigial entries must NOT count as Drift, got %d", len(got.Drift))
	}
	if len(got.Creates) != 1 {
		t.Errorf("want 1 Create for the desired KV, got %d", len(got.Creates))
	}
}

func TestDiff_DeterministicOrder(t *testing.T) {
	t.Parallel()
	d := Desired()
	// Stable input → stable output.
	a := Diff(d, &state.Doc{}, Snapshot{})
	b := Diff(d, &state.Doc{}, Snapshot{})
	if len(a.Creates) != len(b.Creates) {
		t.Fatal("length mismatch on repeat invocation")
	}
	for i := range a.Creates {
		if a.Creates[i].Name != b.Creates[i].Name {
			t.Errorf("non-deterministic at index %d: %q vs %q", i, a.Creates[i].Name, b.Creates[i].Name)
		}
	}
	// Within Creates: D1 before R2 before KV before Queues.
	prev := -1
	for _, e := range a.Creates {
		ord := kindOrder(e.Kind)
		if ord < prev {
			t.Errorf("Creates not sorted by kind: %q after kind-order %d", e.Name, prev)
		}
		prev = ord
	}
}

func TestDiff_R2_AdoptCarriesLiveJurisdiction(t *testing.T) {
	t.Parallel()
	d := &DesiredState{
		R2: []DesiredR2{
			{Name: "polaris-email", Jurisdiction: "eu", ObjectLockHours: 2160},
		},
	}
	snap := Snapshot{
		R2: []LiveR2{
			{Name: "polaris-email", Jurisdiction: "eu"},
		},
	}
	got := Diff(d, &state.Doc{}, snap)
	if len(got.Adopt) != 1 {
		t.Fatalf("want 1 adopt, got %d", len(got.Adopt))
	}
	if got.Adopt[0].Extra["live_jurisdiction"] != "eu" {
		t.Errorf("want live_jurisdiction=eu, got %q", got.Adopt[0].Extra["live_jurisdiction"])
	}
}

func TestDiff_QueueDLQFlagPropagates(t *testing.T) {
	t.Parallel()
	d := Desired()
	got := Diff(d, &state.Doc{}, Snapshot{})
	for _, e := range got.Creates {
		if e.Kind != KindQueue {
			continue
		}
		isDLQ := e.Extra["dlq"] == "true"
		nameSuggestsDLQ := len(e.Name) > 3 && e.Name[len(e.Name)-4:] == "-dlq"
		if isDLQ != nameSuggestsDLQ {
			t.Errorf("DLQ flag mismatch for %s: extra=%v", e.Name, e.Extra)
		}
	}
}

// --- helpers -----------------------------------------------------------------

func buildFullStateDoc(d *DesiredState, ts time.Time) *state.Doc {
	doc := &state.Doc{
		SchemaVersion: state.CurrentSchema,
		CreatedAt:     ts,
		UpdatedAt:     ts,
		D1:            map[string]state.Resource{},
		R2:            map[string]state.R2Bucket{},
		KV:            map[string]state.Resource{},
		Queues:        map[string]state.Resource{},
	}
	for _, r := range d.D1 {
		doc.D1[r.Name] = state.Resource{ID: "id-" + r.Name, Name: r.Name, CreatedAt: ts}
	}
	for _, r := range d.R2 {
		doc.R2[r.Name] = state.R2Bucket{
			Name:            r.Name,
			Jurisdiction:    r.Jurisdiction,
			ObjectLockHours: r.ObjectLockHours,
			CreatedAt:       ts,
		}
	}
	for _, r := range d.KV {
		doc.KV[r.Title] = state.Resource{ID: "id-" + r.Title, Name: r.Title, CreatedAt: ts}
	}
	for _, r := range d.Queues {
		doc.Queues[r.Name] = state.Resource{ID: "id-" + r.Name, Name: r.Name, CreatedAt: ts}
	}
	return doc
}

func buildFullSnapshot(d *DesiredState) Snapshot {
	s := Snapshot{}
	for _, r := range d.D1 {
		s.D1 = append(s.D1, LiveResource{ID: "id-" + r.Name, Name: r.Name})
	}
	for _, r := range d.R2 {
		s.R2 = append(s.R2, LiveR2{Name: r.Name, Jurisdiction: r.Jurisdiction})
	}
	for _, r := range d.KV {
		s.KV = append(s.KV, LiveResource{ID: "id-" + r.Title, Name: r.Title})
	}
	for _, r := range d.Queues {
		s.Queues = append(s.Queues, LiveResource{ID: "id-" + r.Name, Name: r.Name})
	}
	return s
}
