// Package smtp wires go-smtp to the credstore + forwarder.
package smtp

import (
	"context"
	"net"
	"sync"

	gosmtp "github.com/emersion/go-smtp"
	"github.com/oklog/ulid/v2"

	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/audit"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/credstore"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/forwarder"
)

// MaxConnsPerIP caps the number of simultaneous SMTPS connections from one
// remote IP. Holds at the NewSession boundary, before any work is done.
// 10 is comfortably above any realistic legitimate client and 100 below
// the threshold where a single misbehaving peer could starve the listener.
const MaxConnsPerIP = 10

// Deps bundles everything a Backend needs to make Sessions.
type Deps struct {
	Store          *credstore.Store
	Forwarder      *forwarder.Forwarder
	Audit          *audit.Logger
	MaxMessageSize int64
	// Lockout is the per-credential auth-failure throttle. Optional in
	// tests; nil disables the throttle.
	Lockout *credstore.Lockout
}

// Backend implements gosmtp.Backend. The RootContext is the bridge's main
// context; per-session contexts derive from it so a graceful shutdown
// (SIGTERM, ctx.Done()) propagates into in-flight forwarder calls instead
// of riding out the 60s DATA timeout.
type Backend struct {
	Deps        Deps
	RootContext context.Context

	mu       sync.Mutex
	perIP    map[string]int
}

// NewSession returns a new Session, minting a submission ID up front.
// The underlying net.Conn is plumbed so the Session can apply per-DATA
// read deadlines. The session inherits a derived child of RootContext so
// shutdown cancels mid-flight forwarder calls.
func (b *Backend) NewSession(c *gosmtp.Conn) (gosmtp.Session, error) {
	host, _, _ := net.SplitHostPort(c.Conn().RemoteAddr().String())
	if !b.acquireConn(host) {
		return nil, &gosmtp.SMTPError{Code: 421, Message: "too many connections from your address"}
	}
	parent := b.RootContext
	if parent == nil {
		parent = context.Background()
	}
	return &Session{
		deps:         b.Deps,
		clientIP:     host,
		submissionID: ulid.Make().String(),
		ctx:          parent,
		conn:         c.Conn(),
		releaseConn:  func() { b.releaseConn(host) },
	}, nil
}

func (b *Backend) acquireConn(host string) bool {
	if host == "" {
		return true
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.perIP == nil {
		b.perIP = map[string]int{}
	}
	if b.perIP[host] >= MaxConnsPerIP {
		return false
	}
	b.perIP[host]++
	return true
}

func (b *Backend) releaseConn(host string) {
	if host == "" {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.perIP == nil {
		return
	}
	if b.perIP[host] <= 1 {
		delete(b.perIP, host)
		return
	}
	b.perIP[host]--
}
