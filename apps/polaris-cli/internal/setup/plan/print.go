package plan

import (
	"fmt"
	"io"
	"strings"
)

// Render writes a terraform-style summary of p to w. Output shape:
//
//	Plan: N to create, M to adopt, K already present, D drifting.
//	+ create  d1     polaris-mail
//	+ create  r2     polaris-mail                  (jurisdiction=eu, object_lock_hours=2160)
//	+ create  kv     polaris-mail-nonce
//	~ adopt   queue  polaris-mail-fanout           (live=qid-deadbeef)
//	  skip    d1     polaris-mail                  (id=db-uuid)
//	! drift   kv     polaris-mail-stale            (state-only)
//
// Empty plans emit "No changes — all resources present."
func Render(w io.Writer, p *Plan) {
	if p == nil {
		fmt.Fprintln(w, "No plan.")
		return
	}
	total := len(p.Creates) + len(p.Adopt) + len(p.Skips) + len(p.Drift)
	if total == 0 {
		fmt.Fprintln(w, "No changes — desired state is empty.")
		return
	}
	if len(p.Creates) == 0 && len(p.Adopt) == 0 && len(p.Drift) == 0 {
		fmt.Fprintf(w, "No changes — %d resources already present.\n", len(p.Skips))
		// Still surface the skipped list so operators see what was
		// checked.
		writeBucket(w, "  skip   ", p.Skips)
		return
	}

	fmt.Fprintf(w,
		"Plan: %d to create, %d to adopt, %d already present, %d drifting.\n\n",
		len(p.Creates), len(p.Adopt), len(p.Skips), len(p.Drift),
	)
	writeBucket(w, "+ create ", p.Creates)
	writeBucket(w, "~ adopt  ", p.Adopt)
	writeBucket(w, "  skip   ", p.Skips)
	writeBucket(w, "! drift  ", p.Drift)

	if len(p.Drift) > 0 {
		fmt.Fprintln(w)
		fmt.Fprintln(w, "Drift detected: resources recorded in .deploy-state.json are no longer present on Cloudflare.")
		fmt.Fprintln(w, "Run `polaris-mail setup infra state rebuild` to reconcile after manual remediation.")
	}
}

// writeBucket emits one bucket of entries with the given prefix. No-op
// when the bucket is empty.
func writeBucket(w io.Writer, prefix string, entries []Entry) {
	if len(entries) == 0 {
		return
	}
	// Compute name column width for nice alignment.
	width := 0
	for _, e := range entries {
		if l := len(e.Name); l > width {
			width = l
		}
	}
	for _, e := range entries {
		kind := string(e.Kind)
		// Pad the kind column to 6 chars ("queue " etc.) for tidy
		// alignment.
		if len(kind) < 6 {
			kind += strings.Repeat(" ", 6-len(kind))
		}
		name := e.Name
		if l := len(name); l < width {
			name += strings.Repeat(" ", width-l)
		}
		suffix := formatSuffix(e)
		if suffix != "" {
			fmt.Fprintf(w, "%s%s  %s  %s\n", prefix, kind, name, suffix)
		} else {
			fmt.Fprintf(w, "%s%s  %s\n", prefix, kind, name)
		}
	}
}

// formatSuffix builds the per-entry parenthetical (ID, jurisdiction,
// etc.). Returns empty string when there's nothing useful to add.
func formatSuffix(e Entry) string {
	var parts []string
	if e.LiveID != "" {
		parts = append(parts, "id="+e.LiveID)
	}
	if e.StateID != "" && e.Action == ActionDrift {
		parts = append(parts, "state-only id="+e.StateID)
	}
	// Render Extra in a stable order (alphabetical) so output is
	// byte-deterministic.
	if len(e.Extra) > 0 {
		keys := make([]string, 0, len(e.Extra))
		for k := range e.Extra {
			keys = append(keys, k)
		}
		// tiny in-place sort to avoid an import of sort here.
		for i := 1; i < len(keys); i++ {
			for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
				keys[j], keys[j-1] = keys[j-1], keys[j]
			}
		}
		for _, k := range keys {
			parts = append(parts, k+"="+e.Extra[k])
		}
	}
	if len(parts) == 0 {
		return ""
	}
	return "(" + strings.Join(parts, ", ") + ")"
}
