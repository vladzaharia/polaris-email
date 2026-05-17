package plan

import (
	"sort"
	"strings"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/state"
)

// ResourceKind tags each diff entry with the CF resource type. Surfaces
// as a column in the table output and as a field in -o json.
type ResourceKind string

const (
	KindD1    ResourceKind = "d1"
	KindR2    ResourceKind = "r2"
	KindKV    ResourceKind = "kv"
	KindQueue ResourceKind = "queue"
)

// Action is the per-resource verdict the diff loop emits. The four
// cases mirror terraform: create the missing ones, skip the already-
// present ones, surface drift (in state, but not live anymore) and
// adopt (live, but state never recorded it — typically a dashboard
// click).
type Action string

const (
	ActionCreate Action = "create"
	ActionSkip   Action = "skip"
	ActionDrift  Action = "drift"
	ActionAdopt  Action = "adopt"
)

// Entry is one row of the diff. Kind+Name uniquely identify the
// resource; LiveID is the Cloudflare-side ID when the entry is Skip or
// Adopt (Create entries have no ID yet, Drift entries' state ID is
// retained on the StateID field for the rollback path).
type Entry struct {
	Kind    ResourceKind `json:"kind"`
	Name    string       `json:"name"`
	Action  Action       `json:"action"`
	LiveID  string       `json:"live_id,omitempty"`
	StateID string       `json:"state_id,omitempty"`

	// Extra carries kind-specific hints into the renderer (e.g. R2
	// jurisdiction, queue DLQ flag). Empty for D1/KV which have no
	// extra knobs.
	Extra map[string]string `json:"extra,omitempty"`
}

// Plan is the result of Diff(). Entries are bucketed by Action so the
// renderer can print "X to create / Y already present" summaries without
// re-scanning.
type Plan struct {
	Creates []Entry `json:"creates,omitempty"`
	Skips   []Entry `json:"skips,omitempty"`
	Drift   []Entry `json:"drift,omitempty"`
	Adopt   []Entry `json:"adopt,omitempty"`
}

// HasCreates reports whether the plan would mutate anything if applied.
// Used by the `apply` command to short-circuit the confirmation prompt
// when there's nothing to do.
func (p *Plan) HasCreates() bool { return len(p.Creates) > 0 }

// HasDrift reports whether the live snapshot is missing any resource
// the state file claims exists. Drift is a soft failure surface: we
// print it, but apply does not try to "re-create" the missing resource
// because doing so might re-issue an ID and break downstream consumers.
func (p *Plan) HasDrift() bool { return len(p.Drift) > 0 }

// Snapshot is the live Cloudflare inventory the diff path consumes. It
// mirrors the shape of state.CFLister's results: name + ID per
// resource. R2 carries jurisdiction separately so default- vs EU-
// scoped buckets don't accidentally match by name alone.
//
// We define Snapshot in this package (instead of importing from cfapi)
// so the plan package stays free of cfapi imports — keeping the
// dependency graph: cmd → plan, cmd → cfapi (never plan → cfapi).
type Snapshot struct {
	D1     []LiveResource
	R2     []LiveR2
	KV     []LiveResource
	Queues []LiveResource
}

// LiveResource is the minimum {ID, Name} record listed by the CF API.
type LiveResource struct {
	ID   string
	Name string
}

// LiveR2 carries R2-specific bits — the jurisdiction is required to
// disambiguate buckets across the default + EU sweeps.
type LiveR2 struct {
	Name         string
	Jurisdiction string
}

// Diff compares desired vs observed (state file + live snapshot) and
// returns a Plan. The contract for each resource type:
//
//   - desired ∩ live ∩ state → Skip (already correctly present)
//   - desired ∩ live − state → Adopt (live but unrecorded; record on apply)
//   - desired − live          → Create (missing; create + record on apply)
//   - state − live            → Drift (in our ledger but missing on CF;
//     leave alone, just report)
//
// The function is deterministic: entries within each bucket are sorted
// by (Kind, Name) so identical inputs produce byte-identical output
// (load-bearing for plan-output diffs and CI golden tests).
//
// nil-safe: a nil observed or nil snapshot is treated as "everything
// missing", which yields a Plan whose Creates lists every desired
// resource.
func Diff(desired *DesiredState, observed *state.Doc, live Snapshot) *Plan {
	if desired == nil {
		return &Plan{}
	}
	plan := &Plan{}

	// --- D1 ----------------------------------------------------------------
	{
		stateMap := map[string]state.Resource{}
		if observed != nil {
			for name, r := range observed.D1 {
				stateMap[name] = r
			}
		}
		liveMap := map[string]LiveResource{}
		for _, r := range live.D1 {
			liveMap[r.Name] = r
		}
		desiredSet := map[string]struct{}{}
		for _, d := range desired.D1 {
			desiredSet[d.Name] = struct{}{}
			liveRec, hasLive := liveMap[d.Name]
			_, hasState := stateMap[d.Name]
			switch {
			case hasLive && hasState:
				plan.Skips = append(plan.Skips, Entry{
					Kind: KindD1, Name: d.Name, Action: ActionSkip, LiveID: liveRec.ID,
				})
			case hasLive && !hasState:
				plan.Adopt = append(plan.Adopt, Entry{
					Kind: KindD1, Name: d.Name, Action: ActionAdopt, LiveID: liveRec.ID,
				})
			default:
				plan.Creates = append(plan.Creates, Entry{
					Kind: KindD1, Name: d.Name, Action: ActionCreate,
				})
			}
		}
		// Drift: in state, not live, *and* still desired (we don't
		// report drift on resources we no longer want — those are
		// just abandoned).
		for name, st := range stateMap {
			if _, isDesired := desiredSet[name]; !isDesired {
				continue
			}
			if _, isLive := liveMap[name]; isLive {
				continue
			}
			plan.Drift = append(plan.Drift, Entry{
				Kind: KindD1, Name: name, Action: ActionDrift, StateID: st.ID,
			})
		}
	}

	// --- R2 ----------------------------------------------------------------
	{
		stateMap := map[string]state.R2Bucket{}
		if observed != nil {
			for name, b := range observed.R2 {
				stateMap[name] = b
			}
		}
		// Live R2 keyed by name; jurisdiction stashed for the Extra
		// map. R2 names are globally-unique per jurisdiction so the
		// name alone is the key.
		liveMap := map[string]LiveR2{}
		for _, r := range live.R2 {
			liveMap[r.Name] = r
		}
		desiredSet := map[string]struct{}{}
		for _, d := range desired.R2 {
			desiredSet[d.Name] = struct{}{}
			extra := map[string]string{
				"jurisdiction":      d.Jurisdiction,
				"object_lock_hours": itoa(d.ObjectLockHours),
			}
			liveRec, hasLive := liveMap[d.Name]
			_, hasState := stateMap[d.Name]
			switch {
			case hasLive && hasState:
				plan.Skips = append(plan.Skips, Entry{
					Kind: KindR2, Name: d.Name, Action: ActionSkip, Extra: extra,
				})
			case hasLive && !hasState:
				adoptExtra := cloneMap(extra)
				if liveRec.Jurisdiction != "" {
					adoptExtra["live_jurisdiction"] = liveRec.Jurisdiction
				}
				plan.Adopt = append(plan.Adopt, Entry{
					Kind: KindR2, Name: d.Name, Action: ActionAdopt, Extra: adoptExtra,
				})
			default:
				plan.Creates = append(plan.Creates, Entry{
					Kind: KindR2, Name: d.Name, Action: ActionCreate, Extra: extra,
				})
			}
		}
		for name := range stateMap {
			if _, isDesired := desiredSet[name]; !isDesired {
				continue
			}
			if _, isLive := liveMap[name]; isLive {
				continue
			}
			plan.Drift = append(plan.Drift, Entry{
				Kind: KindR2, Name: name, Action: ActionDrift,
			})
		}
	}

	// --- KV ----------------------------------------------------------------
	{
		stateMap := map[string]state.Resource{}
		if observed != nil {
			for name, r := range observed.KV {
				stateMap[name] = r
			}
		}
		liveMap := map[string]LiveResource{}
		for _, r := range live.KV {
			liveMap[r.Name] = r
		}
		desiredSet := map[string]struct{}{}
		for _, d := range desired.KV {
			desiredSet[d.Title] = struct{}{}
			liveRec, hasLive := liveMap[d.Title]
			_, hasState := stateMap[d.Title]
			switch {
			case hasLive && hasState:
				plan.Skips = append(plan.Skips, Entry{
					Kind: KindKV, Name: d.Title, Action: ActionSkip, LiveID: liveRec.ID,
				})
			case hasLive && !hasState:
				plan.Adopt = append(plan.Adopt, Entry{
					Kind: KindKV, Name: d.Title, Action: ActionAdopt, LiveID: liveRec.ID,
				})
			default:
				plan.Creates = append(plan.Creates, Entry{
					Kind: KindKV, Name: d.Title, Action: ActionCreate,
				})
			}
		}
		for name, st := range stateMap {
			if _, isDesired := desiredSet[name]; !isDesired {
				continue
			}
			if _, isLive := liveMap[name]; isLive {
				continue
			}
			plan.Drift = append(plan.Drift, Entry{
				Kind: KindKV, Name: name, Action: ActionDrift, StateID: st.ID,
			})
		}
	}

	// --- Queues ------------------------------------------------------------
	{
		stateMap := map[string]state.Resource{}
		if observed != nil {
			for name, r := range observed.Queues {
				stateMap[name] = r
			}
		}
		liveMap := map[string]LiveResource{}
		for _, r := range live.Queues {
			liveMap[r.Name] = r
		}
		desiredSet := map[string]struct{}{}
		for _, d := range desired.Queues {
			desiredSet[d.Name] = struct{}{}
			extra := map[string]string{}
			if d.DLQ {
				extra["dlq"] = "true"
			}
			liveRec, hasLive := liveMap[d.Name]
			_, hasState := stateMap[d.Name]
			switch {
			case hasLive && hasState:
				plan.Skips = append(plan.Skips, Entry{
					Kind: KindQueue, Name: d.Name, Action: ActionSkip, LiveID: liveRec.ID, Extra: extra,
				})
			case hasLive && !hasState:
				plan.Adopt = append(plan.Adopt, Entry{
					Kind: KindQueue, Name: d.Name, Action: ActionAdopt, LiveID: liveRec.ID, Extra: extra,
				})
			default:
				plan.Creates = append(plan.Creates, Entry{
					Kind: KindQueue, Name: d.Name, Action: ActionCreate, Extra: extra,
				})
			}
		}
		for name, st := range stateMap {
			if _, isDesired := desiredSet[name]; !isDesired {
				continue
			}
			if _, isLive := liveMap[name]; isLive {
				continue
			}
			plan.Drift = append(plan.Drift, Entry{
				Kind: KindQueue, Name: name, Action: ActionDrift, StateID: st.ID,
			})
		}
	}

	sortEntries(plan.Creates)
	sortEntries(plan.Skips)
	sortEntries(plan.Drift)
	sortEntries(plan.Adopt)
	return plan
}

// sortEntries sorts by (Kind, Name) for deterministic output.
func sortEntries(es []Entry) {
	sort.SliceStable(es, func(i, j int) bool {
		if es[i].Kind != es[j].Kind {
			return kindOrder(es[i].Kind) < kindOrder(es[j].Kind)
		}
		return strings.Compare(es[i].Name, es[j].Name) < 0
	})
}

// kindOrder pins the rendering order: D1 → R2 → KV → Queues. Mirrors
// the provision dependency order (the runner walks Creates in the same
// shape).
func kindOrder(k ResourceKind) int {
	switch k {
	case KindD1:
		return 0
	case KindR2:
		return 1
	case KindKV:
		return 2
	case KindQueue:
		return 3
	default:
		return 99
	}
}

// itoa is a stdlib-free int → string for the Extra map. strconv would
// also work; this keeps the imports list small.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func cloneMap(m map[string]string) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}
