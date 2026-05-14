// Package smtp wires go-smtp to the credstore + forwarder.
package smtp

import (
	"context"
	"net"

	gosmtp "github.com/emersion/go-smtp"
	"github.com/oklog/ulid/v2"

	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/audit"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/credstore"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/forwarder"
)

// Deps bundles everything a Backend needs to make Sessions.
type Deps struct {
	Store          *credstore.Store
	Forwarder      *forwarder.Forwarder
	Audit          *audit.Logger
	MaxMessageSize int64
}

// Backend implements gosmtp.Backend.
type Backend struct {
	Deps Deps
}

// NewSession returns a new Session, minting a submission ID up front.
func (b *Backend) NewSession(c *gosmtp.Conn) (gosmtp.Session, error) {
	host, _, _ := net.SplitHostPort(c.Conn().RemoteAddr().String())
	return &Session{
		deps:         b.Deps,
		clientIP:     host,
		submissionID: ulid.Make().String(),
		ctx:          context.Background(),
	}, nil
}
