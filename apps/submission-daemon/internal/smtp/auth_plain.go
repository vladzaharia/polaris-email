package smtp

import (
	"github.com/emersion/go-sasl"
)

// gosmtpServerAuth aliases sasl.Server so backend.go doesn't need the import.
type gosmtpServerAuth = sasl.Server

// newPlainAuth wires sasl PLAIN to the Session.authPlain check.
func newPlainAuth(s *Session) sasl.Server {
	return sasl.NewPlainServer(func(identity, username, password string) error {
		// identity is the authorization-id; we ignore it.
		_ = identity
		return s.authPlain(username, password)
	})
}
