package wranglercfg

import (
	"bytes"
	"fmt"

	"github.com/tailscale/hujson"
)

// Merge deep-merges two JSONC documents, preserving comments and trailing
// commas. The semantics intentionally mirror `jq -s '.[0] * .[1]'`
// (recursive object merge, overlay-wins on scalar/array conflicts) so
// that switching the shell pipeline to this Go path produces byte-equal
// behaviour for every existing wrangler.local.jsonc.
//
// Concretely:
//   - For two objects at the same path, keys are unioned. When a key
//     exists in both, the values are merged recursively.
//   - For two arrays at the same path, the overlay array replaces the
//     base array entirely. (Element-wise merging would require an
//     element-identity strategy and jq's `*` doesn't do it either.)
//   - For any other shape conflict (overlay scalar vs base object, or
//     two scalars), the overlay value wins.
//   - When a key only exists in the overlay, the overlay's
//     BeforeExtra (i.e. its preceding comments) is carried over, so
//     local-only commentary in the overlay survives.
//   - When a key only exists in the base, both the base value and its
//     BeforeExtra are preserved untouched — this is the property the
//     legacy sed+jq pipeline lost (sed stripped // comments before jq
//     could see them, and they survived in the output only because
//     wrangler tolerated re-injected JSONC. We preserve them in-place).
//
// The output is hujson.Format-ted so resulting indentation is canonical
// regardless of the inputs' indentation.
func Merge(base, overlay []byte) ([]byte, error) {
	baseVal, err := hujson.Parse(base)
	if err != nil {
		return nil, fmt.Errorf("wranglercfg.Merge: parse base: %w", err)
	}
	overlayVal, err := hujson.Parse(overlay)
	if err != nil {
		return nil, fmt.Errorf("wranglercfg.Merge: parse overlay: %w", err)
	}

	if err := mergeValue(&baseVal, &overlayVal); err != nil {
		return nil, fmt.Errorf("wranglercfg.Merge: %w", err)
	}

	// Re-format so the output is canonical (consistent indentation +
	// no stale offsets from the in-place mutations above).
	baseVal.Format()
	return baseVal.Pack(), nil
}

// mergeValue recursively merges `overlay` into `dst`. dst is mutated
// in-place; overlay is treated as read-only (callers may pass it as a
// pointer for ergonomic reasons, but mergeValue does not retain
// references to its slices except via Clone).
func mergeValue(dst, overlay *hujson.Value) error {
	dstObj, dstIsObj := dst.Value.(*hujson.Object)
	overObj, overIsObj := overlay.Value.(*hujson.Object)

	// Both objects → recursive merge.
	if dstIsObj && overIsObj {
		mergeObjects(dstObj, overObj)
		// Carry over the overlay's AfterExtra if dst has none — keeps
		// trailing-comment positions stable when overlays add new
		// trailing commentary.
		if len(dst.AfterExtra) == 0 && len(overlay.AfterExtra) > 0 {
			dst.AfterExtra = append(hujson.Extra(nil), overlay.AfterExtra...)
		}
		return nil
	}

	// Any non-(object,object) conflict: overlay replaces. Preserve the
	// existing BeforeExtra on dst (it's the comments leading up to the
	// value's slot in its parent — they belong to dst's position, not
	// to the value content itself).
	beforeExtra := dst.BeforeExtra
	cloned := overlay.Clone()
	*dst = cloned
	if len(beforeExtra) > 0 {
		dst.BeforeExtra = beforeExtra
	}
	return nil
}

// mergeObjects unions overlay's members onto dst. Members present in
// both are recursively merged via mergeValue. Members only in overlay
// are appended in overlay-order, carrying their BeforeExtra (so any
// local-only comments survive). Members only in dst are left in place.
func mergeObjects(dst, overlay *hujson.Object) {
	// Build an index from member-name → position in dst.Members. We
	// have to compare on the *decoded* string, not the raw Literal
	// bytes, because JSON allows multiple ways to spell the same key
	// (escapes, etc.). hujson.Literal.String() handles the decoding.
	index := make(map[string]int, len(dst.Members))
	for i := range dst.Members {
		key := memberKey(&dst.Members[i])
		index[key] = i
	}

	for i := range overlay.Members {
		om := &overlay.Members[i]
		key := memberKey(om)
		if pos, found := index[key]; found {
			// Recurse on the value; leave the dst Name as-is so the
			// base's key formatting (e.g. quoting style) wins.
			_ = mergeValue(&dst.Members[pos].Value, &om.Value)
			continue
		}
		// New key — append a clone so we don't share slices with
		// overlay (which may be mutated by callers).
		dst.Members = append(dst.Members, hujson.ObjectMember{
			Name:  om.Name.Clone(),
			Value: om.Value.Clone(),
		})
		index[key] = len(dst.Members) - 1
	}
}

// memberKey returns the decoded JSON string key for one ObjectMember.
// hujson stores member names as Value with a string Literal underneath;
// the decoded form is the canonical identity for indexing.
func memberKey(m *hujson.ObjectMember) string {
	if lit, ok := m.Name.Value.(hujson.Literal); ok {
		return lit.String()
	}
	// Should be unreachable: JSON object keys are always strings, and
	// hujson parses them as such. Fall back to the raw bytes anyway so
	// we don't panic on malformed input.
	return string(bytes.TrimSpace([]byte(fmt.Sprintf("%v", m.Name.Value))))
}
