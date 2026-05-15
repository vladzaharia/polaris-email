package imap

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
	"github.com/emersion/go-imap/v2/imapserver"
	polarissdk "github.com/polaris-email/polaris-sdk-go"
	"golang.org/x/crypto/bcrypt"

	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/push"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/store"
)

// testFixture wires a Backend up to:
//   - an in-memory store.Mirror seeded with one mailbox + two messages
//     (UID 1 plain, UID 2 with the \Deleted flag set so Expunge has work).
//   - a polarissdk.Client pointed at an httptest server that fakes the
//     handful of polaris endpoints the backend exercises.
//   - a fresh push.Manager.
type testFixture struct {
	t       *testing.T
	backend *Backend
	mirror  *store.Mirror
	push    *push.Manager
	sdk     *polarissdk.Client
	api     *httptest.Server

	// hashedPassword is bcrypt(good-password) at cost 4. cost 4 keeps the
	// unit tests fast; production uses cost 12 (A5).
	hashedPassword string

	// patchCalls / deleteCalls capture API mutations issued by the backend.
	patchCalls  atomic.Int32
	deleteCalls atomic.Int32
}

func newFixture(t *testing.T) *testFixture {
	t.Helper()
	h, err := bcrypt.GenerateFromPassword([]byte("good-password"), 4)
	if err != nil {
		t.Fatalf("bcrypt: %v", err)
	}
	fx := &testFixture{t: t, hashedPassword: string(h)}

	mirror, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("mirror open: %v", err)
	}
	t.Cleanup(func() { _ = mirror.Close() })
	fx.mirror = mirror

	ctx := context.Background()
	if err := mirror.UpsertMessageMeta(ctx, store.MessageMeta{
		ID: "msg-1", MailboxID: "mb-1", FromAddr: "alice@example.com",
		Subject: "hello", HeaderMessageID: "<m1@example.com>",
		BodyBytes: 12, CreatedAt: "2026-05-13T00:00:00Z",
	}); err != nil {
		t.Fatalf("seed meta1: %v", err)
	}
	if err := mirror.UpsertState(ctx, store.MailboxState{
		MailboxID: "mb-1", MessageID: "msg-1", UID: 1, UIDValidity: 1,
		ChangeID: 1, Flags: `[]`,
	}); err != nil {
		t.Fatalf("seed state1: %v", err)
	}
	if err := mirror.UpsertMessageMeta(ctx, store.MessageMeta{
		ID: "msg-2", MailboxID: "mb-1", FromAddr: "bob@example.com",
		Subject: "second", HeaderMessageID: "<m2@example.com>",
		BodyBytes: 20, CreatedAt: "2026-05-13T01:00:00Z",
	}); err != nil {
		t.Fatalf("seed meta2: %v", err)
	}
	if err := mirror.UpsertState(ctx, store.MailboxState{
		MailboxID: "mb-1", MessageID: "msg-2", UID: 2, UIDValidity: 1,
		ChangeID: 2, Flags: `["\\Deleted"]`,
	}); err != nil {
		t.Fatalf("seed state2: %v", err)
	}

	fx.push = push.New()

	mux := http.NewServeMux()
	mux.HandleFunc("/v1/bridge/credentials/lookup", func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("username") {
		case "alice":
			_ = json.NewEncoder(w).Encode(polarissdk.CredentialLookup{
				ID: "c1", MailboxID: "mb-1", Protocol: "imap", AuthType: "password",
				Username: "alice", BcryptHash: fx.hashedPassword,
			})
		default:
			_ = json.NewEncoder(w).Encode(polarissdk.CredentialLookup{})
		}
	})
	mux.HandleFunc("/v1/messages/", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPatch:
			fx.patchCalls.Add(1)
			var body struct {
				Flags []string `json:"flags"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			_ = json.NewEncoder(w).Encode(polarissdk.Message{
				ID: filepath.Base(r.URL.Path), Flags: body.Flags,
			})
		case http.MethodDelete:
			fx.deleteCalls.Add(1)
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	})
	mux.HandleFunc("/v1/messages/get", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			IDs []string `json:"ids"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		out := polarissdk.BulkGetResponse{}
		for _, id := range body.IDs {
			out.Data = append(out.Data, polarissdk.Message{
				ID: id, MailboxID: "mb-1", Subject: "stub", Text: "stub body for " + id,
			})
		}
		_ = json.NewEncoder(w).Encode(out)
	})
	fx.api = httptest.NewServer(mux)
	t.Cleanup(fx.api.Close)

	fx.sdk = polarissdk.NewClient(fx.api.URL)
	fx.sdk.BridgeID = "test-bridge"
	fx.sdk.BridgeSecret = []byte("test-bridge-secret")

	fx.backend = &Backend{
		Client: fx.sdk,
		Mirror: fx.mirror,
		Push:   fx.push,
	}
	return fx
}

// session returns a fresh bridgeSession bound to the fixture backend.
func (fx *testFixture) session() *bridgeSession {
	s, _, err := fx.backend.NewSession(nil)
	if err != nil {
		fx.t.Fatalf("NewSession: %v", err)
	}
	bs, ok := s.(*bridgeSession)
	if !ok {
		fx.t.Fatalf("session type %T", s)
	}
	return bs
}

// shortSockPath returns a unix socket path that fits in the 104-byte limit
// macOS imposes on sun_path. The default t.TempDir() returns a path under
// /var/folders/... that frequently overflows. We use /tmp with a fixed
// prefix and clean up via t.Cleanup.
func shortSockPath(t *testing.T) string {
	t.Helper()
	p := fmt.Sprintf("/tmp/polaris-imap-%d.sock", time.Now().UnixNano())
	t.Cleanup(func() { _ = os.Remove(p) })
	return p
}

// ---------- Backend unit tests ----------

func TestBackend_Login(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name     string
		user     string
		pass     string
		wantErr  error
		wantMbox string
	}{
		{"good", "alice", "good-password", nil, "mb-1"},
		{"bad-password", "alice", "wrong", imapserver.ErrAuthFailed, ""},
		{"unknown-user", "ghost", "anything", imapserver.ErrAuthFailed, ""},
		{"empty-user", "", "x", imapserver.ErrAuthFailed, ""},
		{"empty-pass", "alice", "", imapserver.ErrAuthFailed, ""},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			fx := newFixture(t)
			s := fx.session()
			err := s.Login(c.user, c.pass)
			if err != c.wantErr {
				t.Fatalf("Login err = %v, want %v", err, c.wantErr)
			}
			if got, _, _ := s.snapshot(); got != c.wantMbox {
				t.Fatalf("mailboxID = %q, want %q", got, c.wantMbox)
			}
		})
	}
}

func TestBackend_LoginConstantTimeBurn(t *testing.T) {
	t.Parallel()
	// Smoke test that an unknown-user lookup still spends measurable time
	// in bcrypt — otherwise the timing side channel from A5 would be back.
	fx := newFixture(t)
	s := fx.session()
	start := time.Now()
	_ = s.Login("ghost", "anything")
	elapsed := time.Since(start)
	if elapsed < 100*time.Microsecond {
		t.Fatalf("unknown-user login returned in %v — bcrypt burn not running", elapsed)
	}
}

func TestBackend_SelectInbox(t *testing.T) {
	t.Parallel()
	fx := newFixture(t)
	s := fx.session()
	if err := s.Login("alice", "good-password"); err != nil {
		t.Fatalf("login: %v", err)
	}
	data, err := s.Select("INBOX", nil)
	if err != nil {
		t.Fatalf("select: %v", err)
	}
	if data.NumMessages != 2 {
		t.Fatalf("NumMessages = %d, want 2", data.NumMessages)
	}
	if data.UIDValidity == 0 {
		t.Fatalf("UIDValidity zero")
	}
	if data.UIDNext == 0 {
		t.Fatalf("UIDNext zero")
	}
	if _, _, sel := s.snapshot(); !sel {
		t.Fatalf("session not marked selected")
	}
}

func TestBackend_SelectMissingMailbox(t *testing.T) {
	t.Parallel()
	fx := newFixture(t)
	s := fx.session()
	_ = s.Login("alice", "good-password")
	_, err := s.Select("OTHER", nil)
	if err == nil {
		t.Fatalf("expected error selecting non-INBOX")
	}
	var imapErr *imap.Error
	if !errors.As(err, &imapErr) || imapErr.Code != imap.ResponseCodeNonExistent {
		t.Fatalf("wrong error %#v", err)
	}
}

func TestBackend_SelectCaseInsensitive(t *testing.T) {
	t.Parallel()
	fx := newFixture(t)
	s := fx.session()
	_ = s.Login("alice", "good-password")
	for _, name := range []string{"INBOX", "inbox", "Inbox"} {
		if _, err := s.Select(name, nil); err != nil {
			t.Fatalf("select %q: %v", name, err)
		}
	}
}

func TestBackend_StatusInbox(t *testing.T) {
	t.Parallel()
	fx := newFixture(t)
	s := fx.session()
	_ = s.Login("alice", "good-password")
	d, err := s.Status("INBOX", &imap.StatusOptions{
		NumMessages: true, UIDNext: true, UIDValidity: true,
	})
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if d.Mailbox != "INBOX" {
		t.Fatalf("mailbox %q", d.Mailbox)
	}
	if d.NumMessages == nil || *d.NumMessages != 2 {
		t.Fatalf("NumMessages = %v", d.NumMessages)
	}
}

func TestBackend_RejectedMutations(t *testing.T) {
	t.Parallel()
	fx := newFixture(t)
	s := fx.session()
	if err := s.Create("Folder", nil); err == nil {
		t.Fatal("Create should fail")
	}
	if err := s.Delete("Folder"); err == nil {
		t.Fatal("Delete should fail")
	}
	if err := s.Rename("a", "b", nil); err == nil {
		t.Fatal("Rename should fail")
	}
	if _, err := s.Append("INBOX", nil, nil); err == nil {
		t.Fatal("Append should fail")
	}
	if _, err := s.Copy(imap.SeqSetNum(1), "X"); err == nil {
		t.Fatal("Copy should fail")
	}
}

func TestBackend_IdleBroadcast(t *testing.T) {
	t.Parallel()
	fx := newFixture(t)

	// Build the chanSink directly and verify push.Manager → sink → channel
	// hookup. This is the unit-level proof that a broadcast wakes the Idle
	// loop; the e2e test below exercises the imapserver wire path.
	notify := make(chan struct{}, 4)
	sink := &chanSink{id: "test-sink", ch: notify}
	fx.push.Subscribe("mb-1", sink)
	defer fx.push.Unsubscribe("mb-1", sink.ID())
	fx.push.Broadcast("mb-1", push.StateChange{Type: "test"})
	select {
	case <-notify:
	case <-time.After(time.Second):
		t.Fatalf("sink did not receive broadcast")
	}
}

// ---------- End-to-end integration (real client → real server) ----------

func TestE2E_LoginSelectFetchIdleLogout(t *testing.T) {
	if testing.Short() {
		t.Skip("e2e skipped in -short mode")
	}
	t.Parallel()
	fx := newFixture(t)

	srv := imapserver.New(&imapserver.Options{
		NewSession: fx.backend.NewSession,
		Caps: imap.CapSet{
			imap.CapIMAP4rev1:     {},
			imap.CapIMAP4rev2:     {},
			imap.AuthCap("PLAIN"): {},
		},
		InsecureAuth: true,
	})

	sockPath := shortSockPath(t)
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatalf("listen unix: %v", err)
	}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() {
		_ = srv.Close()
		_ = os.Remove(sockPath)
	})

	rawConn, err := net.DialTimeout("unix", sockPath, 2*time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	// Buffer the unilateral channel so the client read loop never blocks
	// while we wait on it from the test goroutine.
	mailboxCh := make(chan uint32, 4)
	c := imapclient.New(rawConn, &imapclient.Options{
		UnilateralDataHandler: &imapclient.UnilateralDataHandler{
			Mailbox: func(m *imapclient.UnilateralDataMailbox) {
				if m.NumMessages != nil {
					mailboxCh <- *m.NumMessages
				}
			},
		},
	})
	defer c.Close()

	if err := c.Login("alice", "good-password").Wait(); err != nil {
		t.Fatalf("login: %v", err)
	}
	sel, err := c.Select("INBOX", nil).Wait()
	if err != nil {
		t.Fatalf("select: %v", err)
	}
	if sel.NumMessages != 2 {
		t.Fatalf("e2e NumMessages = %d, want 2", sel.NumMessages)
	}

	msgs, err := c.Fetch(imap.UIDSetNum(1, 2), &imap.FetchOptions{
		UID: true, Flags: true, Envelope: true,
	}).Collect()
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if len(msgs) != 2 {
		t.Fatalf("fetched %d messages, want 2", len(msgs))
	}

	idleCmd, err := c.Idle()
	if err != nil {
		t.Fatalf("idle: %v", err)
	}
	// Wait for the server-side sink to register before broadcasting.
	deadline := time.Now().Add(2 * time.Second)
	for fx.push.Count("mb-1") == 0 {
		if time.Now().After(deadline) {
			t.Fatalf("IDLE never registered a sink")
		}
		time.Sleep(5 * time.Millisecond)
	}
	fx.push.Broadcast("mb-1", push.StateChange{Type: "message.received"})
	select {
	case n := <-mailboxCh:
		if n == 0 {
			t.Fatalf("EXISTS=0 from IDLE")
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("no EXISTS within 2s")
	}
	if err := idleCmd.Close(); err != nil {
		t.Fatalf("idle close: %v", err)
	}
	if err := idleCmd.Wait(); err != nil {
		t.Fatalf("idle wait: %v", err)
	}

	if err := c.Logout().Wait(); err != nil {
		t.Fatalf("logout: %v", err)
	}
}

func TestE2E_StoreAndExpunge(t *testing.T) {
	if testing.Short() {
		t.Skip("e2e skipped in -short mode")
	}
	t.Parallel()
	fx := newFixture(t)

	srv := imapserver.New(&imapserver.Options{
		NewSession: fx.backend.NewSession,
		Caps: imap.CapSet{
			imap.CapIMAP4rev1:     {},
			imap.CapIMAP4rev2:     {},
			imap.AuthCap("PLAIN"): {},
		},
		InsecureAuth: true,
	})
	sockPath := shortSockPath(t)
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() {
		_ = srv.Close()
		_ = os.Remove(sockPath)
	})

	conn, err := net.DialTimeout("unix", sockPath, 2*time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	c := imapclient.New(conn, nil)
	defer c.Close()

	if err := c.Login("alice", "good-password").Wait(); err != nil {
		t.Fatalf("login: %v", err)
	}
	if _, err := c.Select("INBOX", nil).Wait(); err != nil {
		t.Fatalf("select: %v", err)
	}

	// Mark UID 1 as \Seen via STORE — expect a PATCH /v1/messages call.
	store := &imap.StoreFlags{Op: imap.StoreFlagsAdd, Flags: []imap.Flag{imap.FlagSeen}, Silent: true}
	if err := c.Store(imap.UIDSetNum(1), store, nil).Close(); err != nil {
		t.Fatalf("store: %v", err)
	}
	if got := fx.patchCalls.Load(); got != 1 {
		t.Fatalf("patchCalls = %d, want 1", got)
	}

	// EXPUNGE — UID 2 has \Deleted from seed, expect a single DELETE.
	if err := c.Expunge().Close(); err != nil {
		t.Fatalf("expunge: %v", err)
	}
	if got := fx.deleteCalls.Load(); got != 1 {
		t.Fatalf("deleteCalls = %d, want 1", got)
	}
}
