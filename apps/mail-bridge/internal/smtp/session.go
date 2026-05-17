package smtp

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"io"
	"net"
	"time"

	gosmtp "github.com/emersion/go-smtp"
	"github.com/oklog/ulid/v2"
	"golang.org/x/crypto/bcrypt"

	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/audit"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/credstore"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/forwarder"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/mime"
)

// dataReadDeadline is the per-DATA wall-clock deadline. The previous
// implementation used a single ReadTimeout on the whole connection, which a
// slow-loris attacker could exhaust by streaming MaxMessageSize+1 bytes
// across the entire window — holding the read buffer hostage for as long
// as the timeout allowed. Wrapping each DATA block in its own deadline
// upper-bounds the time spent buffering one message body and, combined
// with the existing context.WithTimeout wrapping the forwarder call,
// caps total memory residency for a single submission.
const dataReadDeadline = 60 * time.Second

// dummyBcryptHash is used to keep AuthPlain timing constant on credential miss.
// Generated once at init with the same cost we expect bridge hashes to use (12).
var dummyBcryptHash []byte

func init() {
	h, err := bcrypt.GenerateFromPassword([]byte("dummy-password-for-constant-time"), 12)
	if err != nil {
		panic(err)
	}
	dummyBcryptHash = h
}

// Session implements gosmtp.Session and gosmtp.AuthSession.
type Session struct {
	deps         Deps
	ctx          context.Context
	clientIP     string
	submissionID string
	// conn is the underlying TCP connection; we use it to apply a per-DATA
	// SetReadDeadline so a slow-loris attacker can't hold MaxMessageSize+1
	// bytes of buffer in memory for the full ReadTimeout window. May be
	// nil in unit tests that construct Session directly.
	conn net.Conn
	// releaseConn is called from Logout so the per-IP connection counter
	// drops when the session ends. Nil-safe; tests that construct Session
	// directly can leave it unset.
	releaseConn func()

	authedUser   string
	authedCred   *credstore.Credential
	envelopeFrom string
	envelopeTo   []string
	receivedAt   time.Time
}

// AuthMechanisms advertises only PLAIN.
func (s *Session) AuthMechanisms() []string { return []string{"PLAIN"} }

// Auth returns a sasl.Server for PLAIN.
func (s *Session) Auth(mech string) (gosmtpServerAuth, error) {
	if mech != "PLAIN" {
		return nil, gosmtp.ErrAuthUnsupported
	}
	return newPlainAuth(s), nil
}

// authPlain performs constant-time bcrypt comparison.
func (s *Session) authPlain(username, password string) error {
	// Lockout check happens BEFORE the bcrypt comparison so a locked-out
	// attacker doesn't consume CPU on every retry. The check is keyed on
	// `username` so a misconfigured client doesn't poison every account.
	if s.deps.Lockout != nil && s.deps.Lockout.CheckLocked(username, time.Now()) {
		return &gosmtp.SMTPError{Code: 454, Message: "account temporarily locked"}
	}
	cred, err := s.deps.Store.Lookup(username)
	if err != nil {
		// Still burn time so a DB error doesn't leak via timing.
		_ = bcrypt.CompareHashAndPassword(dummyBcryptHash, []byte(password))
		return &gosmtp.SMTPError{Code: 454, Message: "auth temporarily unavailable"}
	}

	hash := dummyBcryptHash
	have := false
	if cred != nil && cred.RevokedAt == nil {
		hash = []byte(cred.BcryptHash)
		have = true
	}

	cmpErr := bcrypt.CompareHashAndPassword(hash, []byte(password))
	// Constant-time AND of "have credential" with "bcrypt matched".
	haveByte := byte(0)
	if have {
		haveByte = 1
	}
	matchByte := byte(0)
	if cmpErr == nil {
		matchByte = 1
	}
	if subtle.ConstantTimeByteEq(haveByte&matchByte, 1) != 1 {
		if s.deps.Lockout != nil {
			s.deps.Lockout.RecordFailure(username, time.Now())
		}
		return &gosmtp.SMTPError{Code: 535, Message: "authentication failed"}
	}
	if s.deps.Lockout != nil {
		s.deps.Lockout.RecordSuccess(username)
	}

	s.authedUser = username
	s.authedCred = cred
	return nil
}

// Mail records the envelope sender.
func (s *Session) Mail(from string, _ *gosmtp.MailOptions) error {
	if s.authedUser == "" {
		return &gosmtp.SMTPError{Code: 530, Message: "authentication required"}
	}
	if s.authedCred != nil && len(s.authedCred.AllowedSenders) > 0 {
		ok := false
		for _, allowed := range s.authedCred.AllowedSenders {
			if allowed == from || allowed == "*" {
				ok = true
				break
			}
		}
		if !ok {
			return &gosmtp.SMTPError{Code: 553, Message: "sender not allowed for this credential"}
		}
	}
	s.envelopeFrom = from
	s.receivedAt = time.Now().UTC()
	return nil
}

// Rcpt appends to the recipient list.
func (s *Session) Rcpt(to string, _ *gosmtp.RcptOptions) error {
	if s.envelopeFrom == "" {
		return &gosmtp.SMTPError{Code: 503, Message: "MAIL required first"}
	}
	s.envelopeTo = append(s.envelopeTo, to)
	return nil
}

// Data reads, canonicalizes, and forwards.
func (s *Session) Data(r io.Reader) error {
	if len(s.envelopeTo) == 0 {
		return &gosmtp.SMTPError{Code: 503, Message: "RCPT required first"}
	}

	// Per-DATA deadline (Phase 4b.2). Without this an attacker streaming
	// MaxMessageSize+1 bytes at a trickle holds memory for the full
	// connection ReadTimeout. The deadline is best-effort: when conn is
	// nil (unit tests) we skip — the LimitReader still bounds total bytes,
	// which is the in-test concern.
	if s.conn != nil {
		_ = s.conn.SetReadDeadline(time.Now().Add(dataReadDeadline))
		// Clear the deadline once DATA finishes (success or failure) so the
		// next command on the same connection uses the server's default
		// per-conn ReadTimeout again.
		defer func() { _ = s.conn.SetReadDeadline(time.Time{}) }()
	}

	limited := io.LimitReader(r, s.deps.MaxMessageSize+1)
	raw, err := io.ReadAll(limited)
	if err != nil {
		return &gosmtp.SMTPError{Code: 451, Message: "read error"}
	}
	if int64(len(raw)) > s.deps.MaxMessageSize {
		return &gosmtp.SMTPError{Code: 552, Message: "message too large"}
	}

	parsed, err := mime.ParseStrict(raw)
	if err != nil {
		var me *mime.MimeError
		if errors.As(err, &me) {
			s.writeAudit(false, 0, len(raw), me.Code+": "+me.Msg)
			return &gosmtp.SMTPError{Code: 550, Message: "5.6.0 MIME policy: " + me.Code}
		}
		s.writeAudit(false, 0, len(raw), "parse: "+err.Error())
		return &gosmtp.SMTPError{Code: 550, Message: "MIME policy violation"}
	}
	canonical := mime.Serialize(parsed)

	ctx, cancel := context.WithTimeout(s.ctx, 60*time.Second)
	defer cancel()
	res, err := s.deps.Forwarder.Forward(ctx, forwarder.ForwardRequest{
		EnvelopeFrom:     s.envelopeFrom,
		EnvelopeTo:       append([]string(nil), s.envelopeTo...),
		RFC822:           canonical,
		SubmissionID:     s.submissionID,
		ClientIP:         s.clientIP,
		ReceivedAtBridge: s.receivedAt,
	})
	if err != nil {
		s.writeAudit(false, 0, len(canonical), "forward: "+err.Error())
		return &gosmtp.SMTPError{Code: 451, Message: "4.4.1 upstream unavailable"}
	}

	switch res.Category {
	case "ok":
		s.writeAudit(true, res.StatusCode, len(canonical), "")
		return nil
	case "transient":
		s.writeAudit(false, res.StatusCode, len(canonical), string(res.Body))
		return &gosmtp.SMTPError{Code: 451, Message: fmt.Sprintf("4.5.0 upstream transient (%d)", res.StatusCode)}
	default:
		s.writeAudit(false, res.StatusCode, len(canonical), string(res.Body))
		return &gosmtp.SMTPError{Code: 554, Message: fmt.Sprintf("5.5.0 upstream rejected (%d)", res.StatusCode)}
	}
}

// Reset clears envelope state and mints a fresh submissionID.
//
// Per RFC 5321 §4.1.1.5, RSET marks the boundary between two distinct
// mail transactions on a single TCP session. Reusing the same submissionID
// across messages causes idempotency-key collisions on the upstream
// forwarder (every transaction looks like a retry of the first), so a
// new ULID is minted here. Auth state is preserved — the client doesn't
// need to re-LOGIN.
func (s *Session) Reset() {
	s.envelopeFrom = ""
	s.envelopeTo = nil
	s.receivedAt = time.Time{}
	s.submissionID = ulid.Make().String()
}

// Logout is a no-op.
func (s *Session) Logout() error {
	if s.releaseConn != nil {
		s.releaseConn()
		s.releaseConn = nil
	}
	return nil
}

func (s *Session) writeAudit(accepted bool, status, size int, errStr string) {
	if s.deps.Audit == nil {
		return
	}
	_ = s.deps.Audit.Write(audit.Entry{
		SubmissionID:   s.submissionID,
		ClientIP:       s.clientIP,
		AuthUser:       s.authedUser,
		Accepted:       accepted,
		UpstreamStatus: status,
		MessageSize:    size,
		Error:          errStr,
	})
}
