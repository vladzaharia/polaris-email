package polarissdk

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newTestClient(t *testing.T, h http.Handler) (*Client, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(h)
	c := NewClient(srv.URL)
	c.KeyID = "01H0000000000000000000000K"
	c.KeySecret = []byte("test-secret-key")
	return c, srv
}

func TestPatchMessageFlags(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/messages/01HABCDEFGHJKMNPQRSTVWXYZ0", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch {
			t.Fatalf("method = %s", r.Method)
		}
		b, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(b), "\\\\Seen") {
			t.Fatalf("body missing flag: %s", string(b))
		}
		_ = json.NewEncoder(w).Encode(Message{ID: "01HABCDEFGHJKMNPQRSTVWXYZ0", Flags: []string{"\\Seen"}, ChangeID: 7})
	})
	c, srv := newTestClient(t, mux)
	defer srv.Close()
	m, err := c.PatchMessageFlags(context.Background(), "01HABCDEFGHJKMNPQRSTVWXYZ0", []string{"\\Seen"})
	if err != nil {
		t.Fatal(err)
	}
	if m.ChangeID != 7 || len(m.Flags) != 1 {
		t.Fatalf("got %+v", m)
	}
}

func TestDeleteMessage(t *testing.T) {
	mux := http.NewServeMux()
	called := false
	mux.HandleFunc("/v1/messages/x", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			called = true
			w.WriteHeader(204)
		}
	})
	c, srv := newTestClient(t, mux)
	defer srv.Close()
	if err := c.DeleteMessage(context.Background(), "x"); err != nil {
		t.Fatal(err)
	}
	if !called {
		t.Fatal("not called")
	}
}

func TestBulkGetMessages(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/messages/get", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(BulkGetResponse{
			Data:     []Message{{ID: "a"}, {ID: "b"}},
			NotFound: []string{"c"},
		})
	})
	c, srv := newTestClient(t, mux)
	defer srv.Close()
	r, err := c.BulkGetMessages(context.Background(), []string{"a", "b", "c"})
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Data) != 2 || len(r.NotFound) != 1 {
		t.Fatalf("got %+v", r)
	}
}

func TestExpungeMailbox(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/mailboxes/mb1/expunge", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(ExpungeResponse{Removed: 3, R2Freed: 2})
	})
	c, srv := newTestClient(t, mux)
	defer srv.Close()
	r, err := c.ExpungeMailbox(context.Background(), "mb1")
	if err != nil {
		t.Fatal(err)
	}
	if r.Removed != 3 || r.R2Freed != 2 {
		t.Fatal("bad payload")
	}
}

func TestGetMailboxChanges(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/mailboxes/mb1/changes", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("since_state") != "5" {
			t.Fatalf("since_state=%s", r.URL.Query().Get("since_state"))
		}
		_ = json.NewEncoder(w).Encode(ChangesResponse{Updated: []string{"a"}, State: 9})
	})
	c, srv := newTestClient(t, mux)
	defer srv.Close()
	r, err := c.GetMailboxChanges(context.Background(), "mb1", 5)
	if err != nil {
		t.Fatal(err)
	}
	if r.State != 9 || len(r.Updated) != 1 {
		t.Fatalf("got %+v", r)
	}
}

func TestListMailboxMessagesMetadata(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/mailboxes/mb1/messages", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("fields") != "metadata" {
			t.Fatal("missing fields=metadata")
		}
		_ = json.NewEncoder(w).Encode(MessageListResponse{Data: []Message{{ID: "a"}, {ID: "b"}}})
	})
	c, srv := newTestClient(t, mux)
	defer srv.Close()
	r, err := c.ListMailboxMessagesMetadata(context.Background(), "mb1", 50, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Data) != 2 {
		t.Fatalf("got %d", len(r.Data))
	}
}

func TestCreateWebhookSub(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/admin/webhook-subs", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(201)
		_ = json.NewEncoder(w).Encode(CreateWebhookSubResponse{ID: "sub1", Secret: "shhh"})
	})
	c, srv := newTestClient(t, mux)
	defer srv.Close()
	r, err := c.CreateWebhookSub(context.Background(), CreateWebhookSubRequest{
		MailboxID: "mb1",
		URL:       "https://x.ts.net/h",
		Kind:      "tailnet",
		Events:    []string{"message.received"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if r.ID != "sub1" || r.Secret != "shhh" {
		t.Fatalf("got %+v", r)
	}
}

func TestLookupMailboxCredential(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/bridge/credentials/lookup", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(CredentialLookup{
			ID: "c1", MailboxID: "mb1", Protocol: "imap", AuthType: "password",
			Username: "alice", BcryptHash: "$2a$10$x",
		})
	})
	c, srv := newTestClient(t, mux)
	defer srv.Close()
	cred, err := c.LookupMailboxCredential(context.Background(), "imap", "alice")
	if err != nil {
		t.Fatal(err)
	}
	if cred.BcryptHash == "" {
		t.Fatal("missing bcrypt hash")
	}
}

