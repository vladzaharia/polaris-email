package smtp

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	gosmtp "github.com/emersion/go-smtp"
	"golang.org/x/crypto/bcrypt"

	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/audit"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/credstore"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/forwarder"
)

func newTestSession(t *testing.T, store *credstore.Store, fwd *forwarder.Forwarder) *Session {
	t.Helper()
	if fwd == nil {
		// Use a stub forwarder pointing at an unreachable URL; tests that need
		// it stub via separate path.
		fwd = forwarder.New(forwarder.Config{APIURL: "http://127.0.0.1:1", BridgeID: "01H000000000000000000TEST0", HMACKey: []byte("test")})
	}
	dir := t.TempDir()
	auditLog, err := audit.New(filepath.Join(dir, "audit.log"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = auditLog.Close() })
	return &Session{
		deps:         Deps{Store: store, Forwarder: fwd, Audit: auditLog, MaxMessageSize: 1 << 20},
		ctx:          context.Background(),
		clientIP:     "1.2.3.4",
		submissionID: "01J0000000000000000000000T",
	}
}

func newStore(t *testing.T) *credstore.Store {
	t.Helper()
	dir := t.TempDir()
	s, err := credstore.Open(filepath.Join(dir, "c.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

// Constant-time path: missing user must take ~the same wall time as a valid
// bcrypt comparison. Tolerance is generous since bcrypt is intentionally slow.
func TestAuthPlain_ConstantTime(t *testing.T) {
	store := newStore(t)
	hash, err := bcrypt.GenerateFromPassword([]byte("right-password"), 12)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertBatch([]credstore.Credential{{
		ID: "id1", Username: "alice", BcryptHash: string(hash),
		AllowedSenders: []string{"alice@example.com"}, MirrorVersion: 1,
	}}); err != nil {
		t.Fatal(err)
	}

	sess := newTestSession(t, store, nil)

	// Time a wrong-password against a real user.
	t0 := time.Now()
	_ = sess.authPlain("alice", "wrong-password")
	dReal := time.Since(t0)

	// Time a missing user.
	t1 := time.Now()
	_ = sess.authPlain("nobody", "wrong-password")
	dMiss := time.Since(t1)

	diff := dMiss - dReal
	if diff < 0 {
		diff = -diff
	}
	// Within 50ms tolerance — both should hit a real bcrypt op.
	if diff > 50*time.Millisecond {
		t.Fatalf("constant-time leak: real=%v miss=%v diff=%v", dReal, dMiss, diff)
	}
	// Sanity: each should take at least 10ms (cost=12).
	if dReal < 10*time.Millisecond || dMiss < 10*time.Millisecond {
		t.Fatalf("bcrypt unexpectedly fast: real=%v miss=%v", dReal, dMiss)
	}
}

func TestAuthPlain_SuccessAndRevoke(t *testing.T) {
	store := newStore(t)
	hash, _ := bcrypt.GenerateFromPassword([]byte("p"), 4)
	now := int64(1)
	if err := store.UpsertBatch([]credstore.Credential{{
		ID: "id1", Username: "u", BcryptHash: string(hash), MirrorVersion: 1,
	}, {
		ID: "id2", Username: "revoked", BcryptHash: string(hash),
		RevokedAt: &now, MirrorVersion: 1,
	}}); err != nil {
		t.Fatal(err)
	}
	sess := newTestSession(t, store, nil)

	if err := sess.authPlain("u", "p"); err != nil {
		t.Fatalf("auth should succeed: %v", err)
	}
	sess2 := newTestSession(t, store, nil)
	if err := sess2.authPlain("revoked", "p"); err == nil {
		t.Fatalf("revoked user must fail")
	}
}

// SMTP error mapping: upstream 4xx → 451, 5xx → 554.
func TestData_UpstreamErrorMapping(t *testing.T) {
	store := newStore(t)
	hash, _ := bcrypt.GenerateFromPassword([]byte("p"), 4)
	if err := store.UpsertBatch([]credstore.Credential{{
		ID: "id1", Username: "u", BcryptHash: string(hash), MirrorVersion: 1,
	}}); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		upstream int
		wantCode int
	}{
		{200, 0},
		{202, 0},
		{400, 554},
		{422, 554},
		{429, 451},
		{500, 451},
		{503, 451},
	}
	for _, c := range cases {
		t.Run("", func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(c.upstream)
			}))
			defer srv.Close()
			fwd := forwarder.New(forwarder.Config{APIURL: srv.URL, BridgeID: "01H000000000000000000TEST0", HMACKey: []byte("test")})
			sess := newTestSession(t, store, fwd)
			if err := sess.authPlain("u", "p"); err != nil {
				t.Fatal(err)
			}
			if err := sess.Mail("a@b", nil); err != nil {
				t.Fatal(err)
			}
			if err := sess.Rcpt("c@d", nil); err != nil {
				t.Fatal(err)
			}
			body := []byte("From: a@b\r\nTo: c@d\r\n\r\nhi\r\n")
			err := sess.Data(bytesReader(body))
			if c.wantCode == 0 {
				if err != nil {
					t.Fatalf("want ok, got %v", err)
				}
				return
			}
			var smtpErr *gosmtp.SMTPError
			if !errors.As(err, &smtpErr) {
				t.Fatalf("want SMTPError, got %T %v", err, err)
			}
			if smtpErr.Code != c.wantCode {
				t.Fatalf("upstream=%d want SMTP %d got %d", c.upstream, c.wantCode, smtpErr.Code)
			}
		})
	}
}

// TestReset_MintsNewSubmissionID proves Phase 4b.3: RSET marks a new mail
// transaction boundary, so the submissionID (used as the upstream
// idempotency key) MUST change. Pre-4b.3 the same ID was reused, causing
// the upstream forwarder to dedup the second message.
func TestReset_MintsNewSubmissionID(t *testing.T) {
	store := newStore(t)
	sess := newTestSession(t, store, nil)
	first := sess.submissionID
	if first == "" {
		t.Fatalf("expected non-empty submissionID")
	}
	sess.Reset()
	second := sess.submissionID
	if second == "" {
		t.Fatalf("Reset must produce a non-empty submissionID")
	}
	if second == first {
		t.Fatalf("Reset did not mint a new submissionID (still %q)", first)
	}
	// And again after a second RSET — every boundary must rotate.
	sess.Reset()
	third := sess.submissionID
	if third == second {
		t.Fatalf("second Reset did not rotate submissionID (still %q)", second)
	}
}

func bytesReader(b []byte) *byteReader { return &byteReader{b: b} }

type byteReader struct {
	b []byte
	i int
}

func (r *byteReader) Read(p []byte) (int, error) {
	if r.i >= len(r.b) {
		return 0, io.EOF
	}
	n := copy(p, r.b[r.i:])
	r.i += n
	return n, nil
}
