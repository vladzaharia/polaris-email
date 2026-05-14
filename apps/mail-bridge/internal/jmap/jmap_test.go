package jmap

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	polarissdk "github.com/polaris-email/polaris-sdk-go"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/push"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/store"
)

// fakeCredentialBackend stands in for polaris during JMAP tests. It returns
// a known jmap bearer-token credential for any lookup.
func newPolarisFake(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/daemon/credentials/lookup", func(w http.ResponseWriter, r *http.Request) {
		proto := r.URL.Query().Get("protocol")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(polarissdk.CredentialLookup{
			ID:          "cred-1",
			MailboxID:   "mb-1",
			Protocol:    proto,
			AuthType:    "bearer_token",
			Username:    "alice",
			BearerToken: r.URL.Query().Get("username"),
		})
	})
	mux.HandleFunc("/v1/messages/get", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(polarissdk.BulkGetResponse{
			Data: []polarissdk.Message{
				{
					ID: "msg-1", MailboxID: "mb-1", Direction: "in", Status: "delivered",
					FromAddr: "a@example.com", Subject: "hello",
					ReceivedAtAPI: "2026-05-13T00:00:00Z", BodyBytes: 10,
				},
			},
			NotFound: []string{},
		})
	})
	return httptest.NewServer(mux)
}

func newJMAPServer(t *testing.T) (*Server, *httptest.Server) {
	t.Helper()
	polaris := newPolarisFake(t)
	mirror, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("mirror: %v", err)
	}
	client := polarissdk.NewClient(polaris.URL)
	client.DaemonID = "test-daemon"
	client.DaemonSecret = []byte("test-secret")
	return New(Options{ListenAddr: ":0", SessionURL: "https://bridge.example"},
		Deps{Client: client, Mirror: mirror, Push: push.New()}), polaris
}

func TestJMAPSession(t *testing.T) {
	srv, polaris := newJMAPServer(t)
	defer polaris.Close()

	req := httptest.NewRequest("GET", "/jmap/session", nil)
	req.Header.Set("Authorization", "Bearer token-123")
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body)
	}
	var s Session
	if err := json.Unmarshal(w.Body.Bytes(), &s); err != nil {
		t.Fatalf("decode: %v body=%s", err, w.Body)
	}
	if _, ok := s.Capabilities["urn:ietf:params:jmap:core"]; !ok {
		t.Error("missing core capability")
	}
	if _, ok := s.Capabilities["urn:ietf:params:jmap:mail"]; !ok {
		t.Error("missing mail capability")
	}
	if s.PrimaryAccounts["urn:ietf:params:jmap:mail"] != "mb-1" {
		t.Errorf("wrong primary account: %v", s.PrimaryAccounts)
	}
}

func TestJMAPMailboxGet(t *testing.T) {
	srv, polaris := newJMAPServer(t)
	defer polaris.Close()

	body := `{
		"using": ["urn:ietf:params:jmap:core","urn:ietf:params:jmap:mail"],
		"methodCalls": [["Mailbox/get", {"accountId":"mb-1"}, "c1"]]
	}`
	req := httptest.NewRequest("POST", "/jmap/api", bytes.NewReader([]byte(body)))
	req.Header.Set("Authorization", "Bearer t")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body)
	}
	if !strings.Contains(w.Body.String(), `"Mailbox/get"`) {
		t.Errorf("missing Mailbox/get response: %s", w.Body)
	}
	if !strings.Contains(w.Body.String(), `"role":"inbox"`) {
		t.Errorf("missing inbox role: %s", w.Body)
	}
}

func TestJMAPEmailGet(t *testing.T) {
	srv, polaris := newJMAPServer(t)
	defer polaris.Close()

	body := `{
		"using": ["urn:ietf:params:jmap:mail"],
		"methodCalls": [["Email/get", {"accountId":"mb-1","ids":["msg-1"]}, "c1"]]
	}`
	req := httptest.NewRequest("POST", "/jmap/api", bytes.NewReader([]byte(body)))
	req.Header.Set("Authorization", "Bearer t")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body)
	}
	if !strings.Contains(w.Body.String(), `"id":"msg-1"`) {
		t.Errorf("missing msg-1 in response: %s", w.Body)
	}
	if !strings.Contains(w.Body.String(), `"subject":"hello"`) {
		t.Errorf("missing subject in response: %s", w.Body)
	}
}

func TestJMAPRejectsMissingAuth(t *testing.T) {
	srv, polaris := newJMAPServer(t)
	defer polaris.Close()
	req := httptest.NewRequest("GET", "/jmap/session", nil)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

func TestKeywordFlagRoundTrip(t *testing.T) {
	flags := []string{"\\Seen", "\\Flagged", "important"}
	kw := flagsToKeywords(flags)
	if !kw["$seen"] || !kw["$flagged"] || !kw["important"] {
		t.Errorf("flagsToKeywords: %v", kw)
	}
	back := keywordsToFlags(kw)
	if len(back) != 3 {
		t.Errorf("keywordsToFlags: %v", back)
	}
}
