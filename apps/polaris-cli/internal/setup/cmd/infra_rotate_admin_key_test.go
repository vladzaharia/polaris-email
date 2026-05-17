package cmd

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
)

// stubAdminAPI is a thin httptest server returning a fixed set of
// /v1/admin/api-keys rows and accepting POST /v1/admin/api-keys with
// a canned response. It does NOT verify HMAC signatures — the unit
// test cares about the rotate flow's decisions, not the wire-level
// auth (covered elsewhere).
func stubAdminAPI(t *testing.T, keys []struct{ Status string }, newKeyID, newKeySecret string) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/admin/api-keys", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			rows := make([]map[string]string, len(keys))
			for i, k := range keys {
				rows[i] = map[string]string{"id": "k" + string(rune('0'+i)), "status": k.Status}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"data": rows})
		case http.MethodPost:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"key_id":     newKeyID,
				"key_secret": newKeySecret,
				"prefix":     "pk_admin_",
				"created_at": 1700000000,
			})
		default:
			http.NotFound(w, r)
		}
	})
	return httptest.NewServer(mux)
}

func TestCountAdminKeys_IgnoresRevoked(t *testing.T) {
	t.Parallel()
	srv := stubAdminAPI(t,
		[]struct{ Status string }{
			{Status: "primary"},
			{Status: "secondary"},
			{Status: "revoked"},
		},
		"", "")
	defer srv.Close()

	cli := client.New(srv.URL, "test-key-id", "test-secret")
	n, err := countAdminKeys(context.Background(), cli)
	if err != nil {
		t.Fatalf("countAdminKeys: %v", err)
	}
	if n != 2 {
		t.Errorf("non-revoked count: got %d, want 2", n)
	}
}

func TestMintAdminKey_ReturnsKeyIDAndSecret(t *testing.T) {
	t.Parallel()
	srv := stubAdminAPI(t, nil, "new-key-id", "new-key-secret")
	defer srv.Close()

	cli := client.New(srv.URL, "test-key-id", "test-secret")
	resp, err := mintAdminKey(context.Background(), cli, "mailbox-123")
	if err != nil {
		t.Fatalf("mintAdminKey: %v", err)
	}
	if resp.AdminKeyID != "new-key-id" || resp.AdminKeySecret != "new-key-secret" {
		t.Errorf("response: %+v", resp)
	}
}

func TestReadWriteBootstrapOutput_RoundTrip(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	p := filepath.Join(dir, ".bootstrap-output.json")
	want := bootstrapOutput{
		AdminKeyID:     "k1",
		AdminKeySecret: "s1",
		MailboxID:      "m1",
		CreatedAt:      "2025-01-01T00:00:00Z",
	}
	if err := writeBootstrapOutput(p, want); err != nil {
		t.Fatal(err)
	}
	got, err := readBootstrapOutput(p)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Errorf("round trip mismatch:\n got=%+v\nwant=%+v", got, want)
	}
	// Mode 0600.
	info, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("bootstrap-output mode: got %o, want 0600", info.Mode().Perm())
	}
}

func TestReadBootstrapOutput_RejectsMissingFields(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	p := filepath.Join(dir, "bo.json")
	if err := os.WriteFile(p, []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := readBootstrapOutput(p)
	if err == nil {
		t.Fatal("want error on empty bootstrap-output")
	}
	if !strings.Contains(err.Error(), "missing") {
		t.Errorf("error: %v", err)
	}
}

func TestWriteAdminKeyArchive_AtomicAndMode0600(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	p := filepath.Join(dir, ".bootstrap-output.archive.json")
	entry := rotatedAdminKey{AdminKeyID: "old", AdminKeySecret: "olds", MailboxID: "m"}
	if err := writeAdminKeyArchive(p, entry); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("archive mode: got %o, want 0600", info.Mode().Perm())
	}
	data, _ := os.ReadFile(p)
	if !strings.Contains(string(data), `"admin_key_id": "old"`) {
		t.Errorf("archive content: %s", data)
	}
}

// Sanity: count + mint via the same client must round-trip with the
// stub's URL parsing (no path bug).
func TestCountAdminKeys_URLConstruction(t *testing.T) {
	t.Parallel()
	srv := stubAdminAPI(t, []struct{ Status string }{{Status: "primary"}}, "", "")
	defer srv.Close()

	cli := client.New(srv.URL, "id", "sec")
	n, err := countAdminKeys(context.Background(), cli)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("count: got %d, want 1", n)
	}
	// And the query string is empty (no ?status= filter):
	u, _ := url.Parse(srv.URL + "/v1/admin/api-keys")
	if u.RawQuery != "" {
		t.Errorf("unexpected query: %q", u.RawQuery)
	}
}
