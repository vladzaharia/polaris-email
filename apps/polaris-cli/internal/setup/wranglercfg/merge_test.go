package wranglercfg

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/tailscale/hujson"
)

// TestMerge_ScalarOverride mirrors jq's `* .[1]` semantics for the
// simplest case: overlay scalar wins.
func TestMerge_ScalarOverride(t *testing.T) {
	t.Parallel()
	base := []byte(`{ "name": "from-base", "kept": "yes" }`)
	overlay := []byte(`{ "name": "from-overlay" }`)
	got, err := Merge(base, overlay)
	if err != nil {
		t.Fatalf("Merge: %v", err)
	}
	asMap := decodeJSON(t, got)
	if asMap["name"] != "from-overlay" {
		t.Errorf("scalar override failed: %v", asMap)
	}
	if asMap["kept"] != "yes" {
		t.Errorf("base-only key dropped: %v", asMap)
	}
}

// TestMerge_RecursiveObjects: nested objects should merge member-wise,
// not replace wholesale. This is the property `jq -s '.[0] * .[1]'`
// guarantees.
func TestMerge_RecursiveObjects(t *testing.T) {
	t.Parallel()
	base := []byte(`{
  "vars": {
    "A": "base-a",
    "B": "base-b"
  }
}`)
	overlay := []byte(`{
  "vars": {
    "B": "overlay-b",
    "C": "overlay-c"
  }
}`)
	got, err := Merge(base, overlay)
	if err != nil {
		t.Fatalf("Merge: %v", err)
	}
	asMap := decodeJSON(t, got)
	vars, _ := asMap["vars"].(map[string]any)
	if vars["A"] != "base-a" {
		t.Errorf("A: want base-a, got %v", vars["A"])
	}
	if vars["B"] != "overlay-b" {
		t.Errorf("B: want overlay-b, got %v", vars["B"])
	}
	if vars["C"] != "overlay-c" {
		t.Errorf("C: want overlay-c, got %v", vars["C"])
	}
}

// TestMerge_ArrayReplaces — `jq * ` replaces arrays wholesale. We match
// the same semantics so existing wrangler.local.jsonc files render the
// same way they did under the shell pipeline.
func TestMerge_ArrayReplaces(t *testing.T) {
	t.Parallel()
	base := []byte(`{
  "d1_databases": [
    { "binding": "DB", "database_id": "REPLACE_WITH_LOCAL" }
  ]
}`)
	overlay := []byte(`{
  "d1_databases": [
    { "binding": "DB", "database_id": "real-id" }
  ]
}`)
	got, err := Merge(base, overlay)
	if err != nil {
		t.Fatalf("Merge: %v", err)
	}
	asMap := decodeJSON(t, got)
	dbs, ok := asMap["d1_databases"].([]any)
	if !ok || len(dbs) != 1 {
		t.Fatalf("d1_databases shape: %v", asMap)
	}
	db := dbs[0].(map[string]any)
	if db["database_id"] != "real-id" {
		t.Errorf("overlay array should win: %v", db)
	}
}

// TestMerge_PreservesBaseComments — the explicit motivation for moving
// off sed+jq: JSONC comments must survive a merge round-trip.
func TestMerge_PreservesBaseComments(t *testing.T) {
	t.Parallel()
	base := []byte(`// header comment on base
{
  // comment on a base-only key
  "kept": "yes",
  // comment on a key the overlay also sets
  "name": "from-base"
}`)
	overlay := []byte(`{ "name": "from-overlay" }`)
	got, err := Merge(base, overlay)
	if err != nil {
		t.Fatalf("Merge: %v", err)
	}
	s := string(got)
	for _, want := range []string{
		"// header comment on base",
		"// comment on a base-only key",
		"// comment on a key the overlay also sets",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("comment lost: %q\noutput:\n%s", want, s)
		}
	}
	if !strings.Contains(s, `"name": "from-overlay"`) {
		t.Errorf("overlay value not applied: %s", s)
	}
}

// TestMerge_PreservesOverlayCommentsForNewKeys — when overlay introduces
// a new key, its leading comments should travel with it.
func TestMerge_PreservesOverlayCommentsForNewKeys(t *testing.T) {
	t.Parallel()
	base := []byte(`{ "kept": "yes" }`)
	overlay := []byte(`{
  // a fresh-comment in the overlay
  "added": "from-overlay"
}`)
	got, err := Merge(base, overlay)
	if err != nil {
		t.Fatalf("Merge: %v", err)
	}
	if !strings.Contains(string(got), "// a fresh-comment in the overlay") {
		t.Errorf("overlay comment on new key was lost:\n%s", got)
	}
	if !strings.Contains(string(got), `"added": "from-overlay"`) {
		t.Errorf("overlay value missing: %s", got)
	}
}

// TestMerge_TrailingCommas — JSONC tolerates trailing commas; hujson
// preserves them; the merger must not blow them away.
func TestMerge_TrailingCommas(t *testing.T) {
	t.Parallel()
	base := []byte(`{
  "items": [
    { "k": "v" },
  ],
}`)
	overlay := []byte(`{ "name": "added" }`)
	got, err := Merge(base, overlay)
	if err != nil {
		t.Fatalf("Merge: %v", err)
	}
	// Standardize and reparse — both should succeed regardless of
	// trailing commas in the source.
	std, err := hujson.Standardize(got)
	if err != nil {
		t.Fatalf("Standardize: %v\n--- got ---\n%s", err, got)
	}
	var asMap map[string]any
	if err := json.Unmarshal(std, &asMap); err != nil {
		t.Fatalf("unmarshal: %v\n--- got ---\n%s", err, got)
	}
}

// TestMerge_InvalidBase / overlay — bad input should produce a clear
// error, not a panic or silent garbage output.
func TestMerge_InvalidBase(t *testing.T) {
	t.Parallel()
	_, err := Merge([]byte(`{ unterminated`), []byte(`{}`))
	if err == nil {
		t.Fatal("Merge: want error on invalid base")
	}
}

func TestMerge_InvalidOverlay(t *testing.T) {
	t.Parallel()
	_, err := Merge([]byte(`{}`), []byte(`{ unterminated`))
	if err == nil {
		t.Fatal("Merge: want error on invalid overlay")
	}
}

// TestMerge_TypeConflictOverlayWins — overlay scalar replaces base object.
// Matches jq's behaviour: `{a: {b:1}} * {a: "x"}` → `{a: "x"}`.
func TestMerge_TypeConflictOverlayWins(t *testing.T) {
	t.Parallel()
	base := []byte(`{ "vars": { "nested": "yes" } }`)
	overlay := []byte(`{ "vars": "scalar" }`)
	got, err := Merge(base, overlay)
	if err != nil {
		t.Fatalf("Merge: %v", err)
	}
	asMap := decodeJSON(t, got)
	if asMap["vars"] != "scalar" {
		t.Errorf("type-conflict: overlay scalar should win, got %v", asMap)
	}
}

// Realistic wrangler-style merge — base is a wrangler.jsonc with
// REPLACE_WITH_LOCAL placeholders, overlay is a rendered
// wrangler.local.jsonc with the real IDs. After merge, the comments in
// base should be intact and the IDs should be those from overlay.
func TestMerge_WranglerStyle(t *testing.T) {
	t.Parallel()
	base := []byte(`// polaris-mail-api Worker — committed config.
{
  "name": "polaris-mail-api",
  "main": "src/index.ts",
  // D1 binding — the real id lives in wrangler.local.jsonc.
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "polaris-mail",
      "database_id": "REPLACE_WITH_LOCAL"
    }
  ],
  "vars": {
    "API_BASE_URL": "https://workers.dev",
    "R2_PUBLIC_HOST": "r2.mail.plrs.im"
  }
}`)
	overlay := []byte(`{
  "account_id": "acc-123",
  "d1_databases": [
    { "binding": "DB", "database_name": "polaris-mail", "database_id": "real-d1-id" }
  ],
  "vars": {
    "API_BASE_URL": "https://api.example.com"
  }
}`)
	got, err := Merge(base, overlay)
	if err != nil {
		t.Fatalf("Merge: %v", err)
	}
	s := string(got)

	// Comments preserved.
	for _, want := range []string{
		"// polaris-mail-api Worker",
		"// D1 binding — the real id lives in wrangler.local.jsonc.",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("comment lost: %q\noutput:\n%s", want, s)
		}
	}

	// Validate the merged semantics with a Standardize pass.
	std, err := hujson.Standardize([]byte(s))
	if err != nil {
		t.Fatalf("Standardize: %v\n%s", err, s)
	}
	var asMap map[string]any
	if err := json.Unmarshal(std, &asMap); err != nil {
		t.Fatalf("unmarshal: %v\n%s", err, std)
	}
	if asMap["account_id"] != "acc-123" {
		t.Errorf("account_id from overlay missing: %v", asMap["account_id"])
	}
	if asMap["name"] != "polaris-mail-api" {
		t.Errorf("name from base missing: %v", asMap["name"])
	}
	if asMap["main"] != "src/index.ts" {
		t.Errorf("main from base missing: %v", asMap["main"])
	}
	dbs := asMap["d1_databases"].([]any)
	if len(dbs) != 1 {
		t.Fatalf("d1_databases: %v", dbs)
	}
	if dbs[0].(map[string]any)["database_id"] != "real-d1-id" {
		t.Errorf("d1 id not from overlay: %v", dbs[0])
	}
	vars := asMap["vars"].(map[string]any)
	if vars["API_BASE_URL"] != "https://api.example.com" {
		t.Errorf("vars.API_BASE_URL not from overlay: %v", vars)
	}
	if vars["R2_PUBLIC_HOST"] != "r2.mail.plrs.im" {
		t.Errorf("vars.R2_PUBLIC_HOST from base lost: %v", vars)
	}
}

// decodeJSON is a Standardize-then-Unmarshal helper. Tests use it when
// they want to assert semantic content without caring about formatting.
func decodeJSON(t *testing.T, b []byte) map[string]any {
	t.Helper()
	std, err := hujson.Standardize(b)
	if err != nil {
		t.Fatalf("decodeJSON Standardize: %v\n--- bytes ---\n%s", err, b)
	}
	var m map[string]any
	if err := json.Unmarshal(std, &m); err != nil {
		t.Fatalf("decodeJSON unmarshal: %v\n--- bytes ---\n%s", err, std)
	}
	return m
}
