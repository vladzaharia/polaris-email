// Package plan describes the *desired* set of Cloudflare resources a
// polaris-email deployment requires, and computes a terraform-style diff
// against what the operator's state file + a live Cloudflare snapshot say
// is actually present.
//
// The desired state is a constant — this package owns the canonical list
// of "what every polaris-email install needs". When that list changes
// (e.g. a new KV namespace is added in a future PR), update [Desired]
// here and the diff path automatically surfaces a Create for it.
//
// This package is deliberately stdlib-only and has no imports from
// cfapi/state beyond the typed shapes those packages export — keeps the
// dependency graph one-way: cmd → plan → {cfapi, state}.
package plan

// DesiredState is the constant list of CF resources every polaris-email
// install must own. The shape mirrors state.Doc just enough that the
// diff loop can compare names side-by-side.
type DesiredState struct {
	// D1 databases by logical name. polaris-email uses exactly one
	// (`polaris-email`); the slice form leaves room for future schema
	// changes.
	D1 []DesiredD1

	// R2 buckets — single archive bucket with EU jurisdiction +
	// Object Lock COMPLIANCE retention. The audit-anchor bucket lives
	// on Backblaze B2, not R2, so it is *not* listed here.
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
// Object Lock retention window. The Object Lock window is in hours
// (CF's REST surface uses hours, not days/months).
type DesiredR2 struct {
	Name            string
	Jurisdiction    string
	ObjectLockHours int
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

// Desired returns the constant DesiredState every polaris-email install
// requires. The list mirrors phases 2–6 of bin/bootstrap.sh — adding or
// removing a resource here without updating that script (or its
// successors) breaks the parity gate.
//
// Resource names are NOT environment-prefixed — polaris-email runs in a
// single production CF account, so resource names are stable across
// installs. (The legacy staging+anchor accounts were collapsed in O1.)
func Desired() *DesiredState {
	return &DesiredState{
		D1: []DesiredD1{
			{Name: "polaris-email"},
		},
		R2: []DesiredR2{
			{
				Name:            "polaris-email",
				Jurisdiction:    "eu",
				ObjectLockHours: 2160, // 90 days, COMPLIANCE mode
			},
		},
		KV: []DesiredKV{
			{Title: "polaris-email-nonce"},
			{Title: "polaris-email-idempotency"},
			{Title: "polaris-email-rate-limit"},
			{Title: "polaris-email-key-cache"},
			{Title: "polaris-email-revocations"},
		},
		Queues: []DesiredQueue{
			{Name: "polaris-email-outbound"},
			{Name: "polaris-email-inbound"},
			{Name: "polaris-email-fanout"},
			{Name: "polaris-email-outbound-dlq", DLQ: true},
			{Name: "polaris-email-fanout-dlq", DLQ: true},
		},
	}
}
