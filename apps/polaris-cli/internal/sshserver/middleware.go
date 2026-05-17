// requireOperatorMiddleware — fingerprints the connecting SSH pubkey,
// resolves it to an operator via the cached /v1/admin/operators/lookup
// route, and attaches the operator to the ssh.Context so the bubbletea
// handler can bind a per-session client.
//
// Unknown / disabled operators see a friendly TUI banner that includes
// their fingerprint (so they can hand it to an admin) before disconnect.
package sshserver

import (
	"context"
	"fmt"
	"time"

	"github.com/charmbracelet/ssh"
	"github.com/charmbracelet/wish"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
)

// Context keys (unexported types to avoid collisions per Go convention).
type ctxKey int

const (
	ctxKeyOperator ctxKey = iota
	ctxKeyConnectedAt
)

// OperatorFromContext is the accessor the bubbletea handler uses.
func OperatorFromContext(c ssh.Context) *client.Operator {
	v := c.Value(ctxKeyOperator)
	op, _ := v.(*client.Operator)
	return op
}

// requireOperatorMiddleware accepts any TCP+SSH handshake (pubkey-auth is
// open at the wish.WithPublicKeyAuth layer) and rejects in-middleware so
// the client sees a friendly banner with their fingerprint, instead of an
// opaque protocol-level disconnect.
func requireOperatorMiddleware(cache *Cache) wish.Middleware {
	return func(next ssh.Handler) ssh.Handler {
		return func(sess ssh.Session) {
			pk := sess.PublicKey()
			if pk == nil {
				wish.Fatalln(sess,
					"polaris-email serve --ssh requires public-key auth.",
					"No SSH key was presented; cannot authenticate.",
				)
				return
			}
			fp := FingerprintSHA256(pk)

			ctx, cancel := context.WithTimeout(sess.Context(), 5*time.Second)
			op, err := cache.Lookup(ctx, fp)
			cancel()
			if err != nil {
				wish.Fatalln(sess, fmt.Sprintf("operator lookup failed: %v", err))
				return
			}
			if op == nil {
				wish.Fatalln(sess,
					"Your SSH key isn't registered with polaris-email.",
					"",
					"Ask an admin to run:",
					"  polaris-email operator add",
					"",
					"Your fingerprint:",
					"  "+fp,
				)
				return
			}
			if op.DisabledAt != nil {
				wish.Fatalln(sess,
					"Your operator account ("+op.Email+") has been disabled.",
					"",
					"Ask an admin to re-enable via `polaris-email operator update`.",
				)
				return
			}

			sess.Context().SetValue(ctxKeyOperator, op)
			sess.Context().SetValue(ctxKeyConnectedAt, time.Now())
			next(sess)
		}
	}
}
