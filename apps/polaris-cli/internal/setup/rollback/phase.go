package rollback

import (
	"context"
	"fmt"
	"io"
	"sort"
	"strings"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/state"
)

// KnownPhases is the canonical list of phase names the setup flow
// stamps in state.Doc.Phases. RollbackPhase refuses unknown phases —
// arbitrary string typos are a footgun (the operator would think the
// flip succeeded when it actually no-oped).
var KnownPhases = []string{
	"preflight",
	"provision",
	"render",
	"migrate",
	"secrets",
	"deploy",
	"smoke",
	"bootstrap",
}

// PhaseRemediation maps a phase name to a short string the operator
// must read before manually cleaning up. The text is intentionally
// direct: "you, the operator, do X". Automating any of these would
// risk destroying customer data — see package doc.
var PhaseRemediation = map[string]string{
	"preflight": "Re-run `setup infra preflight` after fixing the underlying issue. No CF state was mutated by preflight; nothing to clean up.",
	"provision": "Phase created CF resources (D1, R2, KV, queues). Do NOT delete them blindly — D1 destruction is unrecoverable and R2 buckets have Object Lock retention. Inspect `setup infra state show`, decide per-resource, then `wrangler d1 delete` / `wrangler r2 bucket delete` only the ones you actually want gone. Re-run `setup infra` to provision afresh.",
	"render":    "Phase wrote `wrangler.local.jsonc` files. Delete them with `git clean -f services/*/wrangler.local.jsonc apps/*/wrangler.local.jsonc` if you want a clean slate; otherwise just re-run `setup infra render` to re-materialise from the current state.",
	"migrate":   "Phase applied D1 schema migrations. Migrations are forward-only by design — there is no down-migration. If a bad migration shipped, restore D1 from PITR (see runbooks/d1-recovery.md), THEN re-run `setup infra migrate` with the fixed migration.",
	"secrets":   "Phase pushed master secrets to wrangler. Use `setup infra rollback secret <name>` per-secret if the previous values were archived; otherwise re-run `setup infra secrets seed` with the correct source.",
	"deploy":    "Phase deployed Workers via wrangler. Roll back per-Worker with `setup infra rollback deploy <service>`. Re-run `setup infra deploy all` once the underlying code is fixed.",
	"smoke":     "Phase ran end-to-end smoke checks. No state mutated. Re-run `setup infra smoke` once the failure is addressed.",
	"bootstrap": "Phase consumed the one-time `/v1/admin/bootstrap` endpoint and minted the operator admin key. The endpoint refuses a second call. If the admin key was lost, run `setup infra rotate-admin-key` from another admin's session, OR (last resort) wipe the `bootstrap` row in D1 manually.",
}

// PhaseOptions gates RollbackPhase.
type PhaseOptions struct {
	// Out receives the manual-remediation text. nil falls back to
	// discarding the output.
	Out io.Writer
}

// RollbackPhase flips state.Doc.Phases[<name>].CompletedAt back to the
// zero time (by deleting the entry) and prints the manual remediation
// text for that phase.
//
// NEVER auto-deletes CF resources. Deleting a D1 database destroys
// customer data; deleting an R2 bucket fails (Object Lock); deleting
// a KV namespace silently kills idempotency replay protection in
// flight. The operator decides — this function only resets the
// idempotence marker so `--resume` re-runs the phase.
func RollbackPhase(ctx context.Context, store *state.Store, phase string, opts PhaseOptions) error {
	if store == nil {
		return fmt.Errorf("rollback: state store required")
	}
	if !isKnownPhase(phase) {
		return fmt.Errorf("rollback: unknown phase %q; expected one of: %s",
			phase, strings.Join(sortedKnownPhases(), ", "))
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	unlock, err := store.Lock(true)
	if err != nil {
		return err
	}
	defer func() { _ = unlock() }()

	doc, err := store.Read()
	if err != nil {
		return err
	}
	ph, hadEntry := doc.Phases[phase]
	if !hadEntry || ph.CompletedAt.IsZero() {
		// Idempotent: a phase that was never marked complete is
		// already "rolled back".
		writeRemediation(opts.Out, phase, false)
		return nil
	}
	delete(doc.Phases, phase)
	if err := store.Write(doc); err != nil {
		return err
	}
	writeRemediation(opts.Out, phase, true)
	return nil
}

func writeRemediation(w io.Writer, phase string, didReset bool) {
	if w == nil {
		return
	}
	if didReset {
		fmt.Fprintf(w, "rollback: phase %q reset — `--resume` will re-run it.\n\n", phase)
	} else {
		fmt.Fprintf(w, "rollback: phase %q was not marked complete — nothing to reset.\n\n", phase)
	}
	if text, ok := PhaseRemediation[phase]; ok {
		fmt.Fprintf(w, "Manual remediation:\n  %s\n", text)
	}
	fmt.Fprintln(w)
	fmt.Fprintln(w, "Note: rollback never deletes CF resources automatically — "+
		"D1, R2, and KV deletes are unrecoverable. Inspect `setup infra state show` "+
		"and decide per-resource.")
}

func isKnownPhase(name string) bool {
	for _, p := range KnownPhases {
		if p == name {
			return true
		}
	}
	return false
}

func sortedKnownPhases() []string {
	out := make([]string, len(KnownPhases))
	copy(out, KnownPhases)
	sort.Strings(out)
	return out
}
