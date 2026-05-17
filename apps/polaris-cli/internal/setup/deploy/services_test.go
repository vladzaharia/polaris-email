package deploy

import "testing"

func TestServices_OrderIsCanonical(t *testing.T) {
	t.Parallel()
	// Critical contract: tail must be first (its name is referenced as a
	// tail_consumers entry from api/in/out/panel); cli-installer must be
	// last. Reordering this slice is a deliberate decision — the
	// regression test catches accidental edits.
	want := []string{"tail", "api", "out", "in", "panel", "docs", "cli-installer"}
	got := Names()
	if len(got) != len(want) {
		t.Fatalf("len: want %d, got %d", len(want), len(got))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("order[%d]: want %s, got %s", i, want[i], got[i])
		}
	}
}

func TestServices_PanelAndDocsAreClientBuilds(t *testing.T) {
	t.Parallel()
	cases := map[string]bool{
		"tail":          false,
		"api":           false,
		"out":           false,
		"in":            false,
		"panel":         true,
		"docs":          true,
		"cli-installer": false,
	}
	for name, want := range cases {
		s, ok := ByName(name)
		if !ok {
			t.Fatalf("missing service: %s", name)
		}
		if s.IsClientBuild != want {
			t.Errorf("%s.IsClientBuild: want %v, got %v", name, want, s.IsClientBuild)
		}
	}
}

func TestByName_MissingReturnsFalse(t *testing.T) {
	t.Parallel()
	_, ok := ByName("nope")
	if ok {
		t.Error("ByName(nope): want ok=false")
	}
}
