package deploy

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseVersionID_FixtureCoverage(t *testing.T) {
	t.Parallel()
	cases := []struct {
		fixture string
		want    string
	}{
		{"4.0-classic.txt", "9c1b9d3d-1234-4567-89ab-cdef01234567"},
		{"4.50-deployment-id.txt", "7913f7aa-deaf-beef-cafe-cafedeadbeef"},
		{"4.90-current-version.txt", "deadbeef-cafe-babe-feed-deadbeefcafe"},
		{"no-version-line.txt", ""},
	}
	for _, tc := range cases {
		t.Run(tc.fixture, func(t *testing.T) {
			data, err := os.ReadFile(filepath.Join("testdata", "wrangler-deploy-output", tc.fixture))
			if err != nil {
				t.Fatalf("read fixture: %v", err)
			}
			got := ParseVersionID(data)
			if got != tc.want {
				t.Errorf("fixture %s: want %q, got %q", tc.fixture, tc.want, got)
			}
		})
	}
}

func TestParseVersionID_EmptyInput(t *testing.T) {
	t.Parallel()
	if got := ParseVersionID(nil); got != "" {
		t.Errorf("nil input: want empty, got %q", got)
	}
	if got := ParseVersionID([]byte("")); got != "" {
		t.Errorf("empty input: want empty, got %q", got)
	}
}
