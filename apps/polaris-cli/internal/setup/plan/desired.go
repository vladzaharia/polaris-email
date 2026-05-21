// Package plan describes the *desired* set of Cloudflare resources a
// polaris-mail deployment requires, and computes a terraform-style diff
// against what the operator's state file + a live Cloudflare snapshot say
// is actually present.
//
// The desired state is a constant — this package owns the canonical list
// of "what every polaris-mail install needs". When that list changes
// (e.g. a new KV namespace is added), update [Desired] here and the
// diff path automatically surfaces a Create for it.
//
// This package is deliberately stdlib-only and has no imports from
// cfapi/state beyond the typed shapes those packages export — keeps the
// dependency graph one-way: cmd → plan → {cfapi, state}.
package plan

// DesiredState is the constant list of CF resources every polaris-mail
// install must own. The shape mirrors state.Doc just enough that the
// diff loop can compare names side-by-side.
type DesiredState struct {
	// D1 databases by logical name. polaris-mail uses exactly one
	// (`polaris-mail`); the slice form leaves room for future schema
	// changes.
	D1 []DesiredD1

	// R2 buckets — single archive bucket with EU jurisdiction +
	// Object Lock COMPLIANCE retention for tamper-evidence on the
	// message-body archive.
	R2 []DesiredR2

	// KV namespaces by title (the .title field CF stores).
	KV []DesiredKV

	// Queues + DLQs. DLQ=true is informational — the create call is
	// identical for both, but operators care about the distinction
	// when reading the plan output.
	Queues []DesiredQueue
}

// DesiredD1 captures the canonical name of a D1 database the install
// expects. No additional fields are needed because D1 has no
// configuration knobs at create-time beyond the name.
type DesiredD1 struct {
	Name string
}

// DesiredR2 captures the canonical bucket name + the jurisdiction +
// region hint + retention window. The Object Lock window is in hours
// (CF's REST surface uses hours, not days/months).
//
// Jurisdiction is one of "", "eu", "fedramp". Empty means CF's
// "default" jurisdiction (no compliance scope). LocationHint is one
// of the documented R2 region codes (WNAM, ENAM, WEUR, EEUR, APAC, OC)
// — CF uses it to pick the colo region; bucket names are still
// globally unique within an account.
//
// LifecycleExpiryDays is mutually exclusive with ObjectLockHours: when
// non-zero, the provision step applies a delete-after-N-days lifecycle
// rule instead of Object Lock COMPLIANCE. Used for the
// `polaris-mail-logs` bucket where we want bounded retention but not
// tamper-evidence (those logs are operator-side observability, not
// audit chain anchors).
type DesiredR2 struct {
	Name                string
	Jurisdiction        string
	LocationHint        string
	ObjectLockHours     int
	LifecycleExpiryDays int
	// PublicDomain, when set, instructs the provision phase to bind that
	// hostname as the bucket's public custom domain. Empty means "leave
	// the bucket privately addressable" (the default for log buckets).
	// Populated from .env.deploy's R2_PUBLIC_HOST in the apply caller, not
	// in this constant.
	PublicDomain string
}

// DesiredKV captures the canonical KV namespace title.
type DesiredKV struct {
	Title string
}

// DesiredQueue captures the canonical queue name + a marker for DLQs.
// CF Queues itself has no DLQ-vs-regular distinction at the resource
// level; the bool just shapes prettier human output.
type DesiredQueue struct {
	Name string
	DLQ  bool
}

// Desired returns the constant DesiredState every polaris-mail install
// requires.
//
// Resource names are NOT environment-prefixed — polaris-mail runs in a
// single production CF account, so resource names are stable across
// installs.
//
// The R2 `PublicDomain` field is left zero here; the apply caller fills
// it in from .env.deploy's R2_PUBLIC_HOST via WithR2PublicDomain before
// passing the result to Diff.
func Desired() *DesiredState {
	return &DesiredState{
		D1: []DesiredD1{
			{Name: "polaris-mail"},
		},
		R2: []DesiredR2{
			{
				// Default-jurisdiction US-west bucket — no compliance
				// scope ("eu" jurisdiction was the previous default
				// and is preserved by adoption when an operator's
				// account already has the bucket there). WNAM region
				// hint places new buckets in Western North America.
				Name:            "polaris-mail",
				Jurisdiction:    "",
				LocationHint:    "wnam",
				ObjectLockHours: 2160, // 90 days, COMPLIANCE mode
			},
			{
				// Auto-provisioned logs bucket fed by the Logpush job.
				// 30-day lifecycle expiry — covers the typical
				// "fix it within a month" incident-response window
				// without unbounded R2 spend. Object Lock is
				// deliberately NOT applied — these are operator-side
				// observability artifacts, not audit-chain anchors.
				Name:                "polaris-mail-logs",
				Jurisdiction:        "",
				LocationHint:        "wnam",
				LifecycleExpiryDays: 30,
			},
		},
		KV: []DesiredKV{
			{Title: "polaris-mail-nonce"},
			{Title: "polaris-mail-idempotency"},
			{Title: "polaris-mail-rate-limit"},
			{Title: "polaris-mail-key-cache"},
			{Title: "polaris-mail-revocations"},
		},
		Queues: []DesiredQueue{
			{Name: "polaris-mail-outbound"},
			{Name: "polaris-mail-inbound"},
			{Name: "polaris-mail-fanout"},
			{Name: "polaris-mail-outbound-dlq", DLQ: true},
			{Name: "polaris-mail-fanout-dlq", DLQ: true},
		},
	}
}

// WithR2PublicDomain sets the PublicDomain field on the bucket named
// "polaris-mail" (the archive bucket — the only one we publicly serve)
// and returns the state for chaining. Empty host is a no-op so callers
// can pass through whatever .env.deploy gives them without branching.
func WithR2PublicDomain(d *DesiredState, host string) *DesiredState {
	if d == nil || host == "" {
		return d
	}
	for i := range d.R2 {
		if d.R2[i].Name == "polaris-mail" {
			d.R2[i].PublicDomain = host
		}
	}
	return d
}
