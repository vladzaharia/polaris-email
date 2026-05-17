package imap

import (
	"bytes"
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
	// unit tests fast; production uses cost 12.
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

// ---------- Phase 2e regression tests ----------

// TestE2E_Expunge_MultiMessageSequenceNumbers proves the EXPUNGE sequence
// arithmetic in backend.go. Pre-2e the loop used `i+1` against the original
// index walked in descending order, which produced wrong sequence numbers
// when more than one message was deleted in a single EXPUNGE response.
//
// Setup: 5 live messages (UIDs 10..14), mark UIDs 11, 13, 14 \Deleted, then
// EXPUNGE. The library client returns the emitted sequence numbers via
// Expunge().Collect(); we verify the post-shrink-aware values.
//
//	original seq:  1  2  3  4  5
//	UID:           10 11 12 13 14
//	flags:         -  D  -  D  D
//
// Walk order: i=1 emits seq 2 (UID 11), i=3 emits seq 2 (UID 13 was at seq
// 4, minus 2 because two prior deletes already shifted: wait — only one
// prior delete (UID 11) when we reach UID 13, so i+1=4 minus 1 = 3),
// i=4 emits seq 3 (UID 14 was at seq 5; two prior deletes ⇒ 5-2=3).
//
// Expected emitted sequence: [2, 3, 3].
func TestE2E_Expunge_MultiMessageSequenceNumbers(t *testing.T) {
	if testing.Short() {
		t.Skip("e2e skipped in -short mode")
	}
	t.Parallel()
	fx := newFixture(t)
	ctx := context.Background()

	// Reset the seeded mailbox-state to a known 5-row layout.
	if _, err := fx.mirror.DB.ExecContext(ctx, `DELETE FROM mailbox_state WHERE mailbox_id = ?`, "mb-1"); err != nil {
		t.Fatalf("clear: %v", err)
	}
	type row struct {
		id    string
		uid   int64
		flags string
	}
	rows := []row{
		{"m10", 10, `[]`},
		{"m11", 11, `["\\Deleted"]`},
		{"m12", 12, `[]`},
		{"m13", 13, `["\\Deleted"]`},
		{"m14", 14, `["\\Deleted"]`},
	}
	for _, r := range rows {
		if err := fx.mirror.UpsertMessageMeta(ctx, store.MessageMeta{
			ID: r.id, MailboxID: "mb-1", FromAddr: "x@x", Subject: r.id,
			BodyBytes: 1, CreatedAt: "2026-05-13T00:00:00Z",
		}); err != nil {
			t.Fatalf("seed meta: %v", err)
		}
		if err := fx.mirror.UpsertState(ctx, store.MailboxState{
			MailboxID: "mb-1", MessageID: r.id, UID: r.uid, UIDValidity: 1,
			ChangeID: r.uid, Flags: r.flags,
		}); err != nil {
			t.Fatalf("seed state: %v", err)
		}
	}

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
	t.Cleanup(func() { _ = srv.Close(); _ = os.Remove(sockPath) })

	conn, err := net.DialTimeout("unix", sockPath, 2*time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	c := imapclient.New(conn, nil)
	defer c.Close()

	if err := c.Login("alice", "good-password").Wait(); err != nil {
		t.Fatalf("login: %v", err)
	}
	sel, err := c.Select("INBOX", nil).Wait()
	if err != nil {
		t.Fatalf("select: %v", err)
	}
	if sel.NumMessages != 5 {
		t.Fatalf("NumMessages = %d, want 5", sel.NumMessages)
	}

	seqs, err := c.Expunge().Collect()
	if err != nil {
		t.Fatalf("expunge: %v", err)
	}
	want := []uint32{2, 3, 3}
	if len(seqs) != len(want) {
		t.Fatalf("emit count %d, want %d (got %v)", len(seqs), len(want), seqs)
	}
	for i, got := range seqs {
		if got != want[i] {
			t.Fatalf("emit[%d] = %d, want %d (full=%v)", i, got, want[i], seqs)
		}
	}
	if got := fx.deleteCalls.Load(); got != 3 {
		t.Fatalf("API delete calls = %d, want 3", got)
	}
}

// TestStore_PersistsToMirror proves the flags_json column fix. Pre-2e the
// UpdateFlags helper wrote to a non-existent `flags` column, the error was
// swallowed, and the mirror silently retained the prior flag set. We
// invoke STORE then read the row back via ListLiveMessageIDs and assert
// the flags_json column actually changed.
func TestStore_PersistsToMirror(t *testing.T) {
	t.Parallel()
	fx := newFixture(t)
	ctx := context.Background()

	s := fx.session()
	if err := s.Login("alice", "good-password"); err != nil {
		t.Fatalf("login: %v", err)
	}
	if _, err := s.Select("INBOX", nil); err != nil {
		t.Fatalf("select: %v", err)
	}

	op := &imap.StoreFlags{
		Op:     imap.StoreFlagsAdd,
		Flags:  []imap.Flag{imap.FlagSeen, imap.FlagFlagged},
		Silent: true,
	}
	if err := s.Store(nil, imap.UIDSetNum(1), op, nil); err != nil {
		t.Fatalf("store: %v", err)
	}

	// Read the raw flags_json column back so we know the SQL UPDATE
	// targeted the right column.
	var raw string
	if err := fx.mirror.DB.QueryRowContext(ctx,
		`SELECT flags_json FROM mailbox_state WHERE mailbox_id = ? AND message_id = ?`,
		"mb-1", "msg-1").Scan(&raw); err != nil {
		t.Fatalf("scan flags_json: %v", err)
	}
	var stored []string
	if err := json.Unmarshal([]byte(raw), &stored); err != nil {
		t.Fatalf("flags_json not parseable: %v (raw=%q)", err, raw)
	}
	wantSet := map[string]bool{`\Seen`: true, `\Flagged`: true}
	for _, f := range stored {
		delete(wantSet, f)
	}
	if len(wantSet) > 0 {
		t.Fatalf("expected flags %v not persisted (got %v)", wantSet, stored)
	}
}

// TestFetchBody_RFC822Wrapper proves the BODY[] fetch returns a parseable
// RFC822 blob when the message has no BodyURL. Pre-2e the handler returned
// the bare Text bytes which lacked the CRLF-CRLF separator, so HEADER /
// TEXT slicing returned nonsense.
func TestFetchBody_RFC822Wrapper(t *testing.T) {
	t.Parallel()
	fx := newFixture(t)
	ctx := context.Background()

	s := fx.session()
	if err := s.Login("alice", "good-password"); err != nil {
		t.Fatalf("login: %v", err)
	}
	body, err := s.fetchBody(ctx, "msg-1", &store.MessageMeta{
		ID: "msg-1", MailboxID: "mb-1",
		FromAddr: "alice@example.com", Subject: "hello",
		HeaderMessageID: "<m1@example.com>", BodyBytes: 12,
		CreatedAt: "2026-05-13T00:00:00Z",
	})
	if err != nil {
		t.Fatalf("fetchBody: %v", err)
	}
	idx := bytes.Index(body, []byte("\r\n\r\n"))
	if idx < 0 {
		t.Fatalf("RFC822 blob missing CRLF-CRLF separator: %q", body)
	}
	header := body[:idx]
	for _, want := range []string{"Subject:", "From:", "MIME-Version:"} {
		if !bytes.Contains(header, []byte(want)) {
			t.Fatalf("missing %s header: %q", want, header)
		}
	}
}

// TestFetchBody_R2LimitReader proves the io.LimitReader cap defends against
// an oversized R2 attachment fetch. We point Backend.HTTP at a stub that
// streams more than the cap; the result must be truncated, not OOM.
func TestFetchBody_R2LimitReader(t *testing.T) {
	t.Parallel()

	// Stream > 100 KiB; cap will be 64 KiB below.
	bodySrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "message/rfc822")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(bytes.Repeat([]byte("X"), 200*1024))
	}))
	defer bodySrv.Close()

	fx := newFixture(t)
	// Replace the bulk-get handler so GetMessage returns a BodyURL pointing
	// at our stream stub.
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
	mux.HandleFunc("/v1/messages/get", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(polarissdk.BulkGetResponse{
			Data: []polarissdk.Message{{ID: "msg-1", MailboxID: "mb-1", Subject: "big", BodyURL: bodySrv.URL}},
		})
	})
	apiSrv := httptest.NewServer(mux)
	defer apiSrv.Close()
	fx.sdk = polarissdk.NewClient(apiSrv.URL)
	fx.sdk.BridgeID = "test-bridge"
	fx.sdk.BridgeSecret = []byte("test-bridge-secret")
	fx.backend.Client = fx.sdk
	fx.backend.MaxBodyBytes = 64 * 1024

	s := fx.session()
	if err := s.Login("alice", "good-password"); err != nil {
		t.Fatalf("login: %v", err)
	}
	body, err := s.fetchBody(context.Background(), "msg-1", nil)
	if err != nil {
		t.Fatalf("fetchBody: %v", err)
	}
	if int64(len(body)) != fx.backend.MaxBodyBytes {
		t.Fatalf("body length %d, want %d (cap should truncate)", len(body), fx.backend.MaxBodyBytes)
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

// TestSearch_AllReturnsAllUIDs proves Phase 4c.1: SEARCH ALL surfaces
// every live UID via the local mirror (no upstream call). Pre-4c.1 the
// session returned an empty SearchData for any criteria.
func TestSearch_AllReturnsAllUIDs(t *testing.T) {
	t.Parallel()
	fx := newFixture(t)
	s := fx.session()
	if err := s.Login("alice", "good-password"); err != nil {
		t.Fatalf("login: %v", err)
	}
	if _, err := s.Select("INBOX", nil); err != nil {
		t.Fatalf("select: %v", err)
	}
	// Empty criteria (== ALL).
	data, err := s.Search(imapserver.NumKindUID, &imap.SearchCriteria{}, nil)
	if err != nil {
		t.Fatalf("search ALL: %v", err)
	}
	uids, ok := data.All.(imap.UIDSet)
	if !ok {
		t.Fatalf("ALL set type %T, want UIDSet", data.All)
	}
	got, _ := uids.Nums()
	wantSet := map[imap.UID]bool{1: true, 2: true}
	if len(got) != len(wantSet) {
		t.Fatalf("ALL UIDs = %v, want %v", got, wantSet)
	}
	for _, u := range got {
		if !wantSet[u] {
			t.Fatalf("unexpected UID %d in ALL result %v", u, got)
		}
	}
}

// TestSearch_UnseenExcludesSeen proves UNSEEN filters out rows whose
// flags include "\Seen". The seed has UID 1 with empty flags and UID 2
// with [\Deleted]; mark UID 1 \Seen and confirm only UID 2 comes back.
func TestSearch_UnseenExcludesSeen(t *testing.T) {
	t.Parallel()
	fx := newFixture(t)
	ctx := context.Background()

	// Mark UID 1 \Seen directly in the mirror so we don't depend on the
	// SDK round-trip; SEARCH reads from the mirror.
	if err := fx.mirror.UpdateFlags(ctx, "mb-1", "msg-1", []string{`\Seen`}); err != nil {
		t.Fatalf("seed seen: %v", err)
	}

	s := fx.session()
	if err := s.Login("alice", "good-password"); err != nil {
		t.Fatalf("login: %v", err)
	}
	if _, err := s.Select("INBOX", nil); err != nil {
		t.Fatalf("select: %v", err)
	}
	criteria := &imap.SearchCriteria{NotFlag: []imap.Flag{imap.FlagSeen}}
	data, err := s.Search(imapserver.NumKindUID, criteria, nil)
	if err != nil {
		t.Fatalf("search UNSEEN: %v", err)
	}
	uids, ok := data.All.(imap.UIDSet)
	if !ok {
		t.Fatalf("UNSEEN set type %T, want UIDSet", data.All)
	}
	got, _ := uids.Nums()
	if len(got) != 1 || got[0] != imap.UID(2) {
		t.Fatalf("UNSEEN UIDs = %v, want [2]", got)
	}
}

// TestSearch_RequiresSelected proves SEARCH errors when called outside
// the selected state.
func TestSearch_RequiresSelected(t *testing.T) {
	t.Parallel()
	fx := newFixture(t)
	s := fx.session()
	if err := s.Login("alice", "good-password"); err != nil {
		t.Fatalf("login: %v", err)
	}
	if _, err := s.Search(imapserver.NumKindUID, &imap.SearchCriteria{}, nil); err == nil {
		t.Fatalf("expected error from SEARCH without SELECT")
	}
}

// TestSubscribeUnsubscribe_NoOp proves Phase 4c.3: both methods accept
// any folder name without error, since INBOX is the only real mailbox
// and is implicitly always-subscribed.
func TestSubscribeUnsubscribe_NoOp(t *testing.T) {
	t.Parallel()
	fx := newFixture(t)
	s := fx.session()
	if err := s.Login("alice", "good-password"); err != nil {
		t.Fatalf("login: %v", err)
	}
	for _, name := range []string{"INBOX", "Trash", "Sent", ""} {
		if err := s.Subscribe(name); err != nil {
			t.Fatalf("Subscribe(%q): %v", name, err)
		}
		if err := s.Unsubscribe(name); err != nil {
			t.Fatalf("Unsubscribe(%q): %v", name, err)
		}
	}
}
