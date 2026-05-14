// Package imap implements a hand-rolled IMAP4rev2 subset for the polaris
// mail bridge. This is a functional skeleton: LOGIN / LOGOUT / CAPABILITY /
// LIST / SELECT INBOX / NOOP / STATUS / FETCH / STORE / EXPUNGE / CLOSE /
// IDLE work against the SDK. Production gaps (full SEARCH, BODY[...] parts,
// MULTIAPPEND, etc.) are marked TODO(production).
//
// The server reads + writes one connection at a time per session goroutine.
// Push fan-out into IDLE sessions is handled by registering an IDLE Sink
// with the shared push.Manager when IDLE starts.
package imap

import (
	"context"
	"crypto/tls"
	"log"
	"net"
	"sync"

	polarissdk "github.com/polaris-email/polaris-sdk-go"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/push"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/store"
)

// Deps is the set of bridge subsystems an IMAP server needs.
type Deps struct {
	Client *polarissdk.Client
	Mirror *store.Mirror
	Push   *push.Manager
	Logger *log.Logger
}

// Options configure the listener side.
type Options struct {
	ListenAddr string
	TLSConfig  *tls.Config // optional. If nil, the server runs cleartext
	// (only acceptable when terminated by a sidecar / proxy that owns TLS).
}

// Server is a one-shot IMAP4rev2 listener.
type Server struct {
	opts Options
	deps Deps
	mu   sync.Mutex
	ln   net.Listener
}

// New constructs a Server. It does not listen yet.
func New(opts Options, deps Deps) *Server {
	if deps.Logger == nil {
		deps.Logger = log.Default()
	}
	return &Server{opts: opts, deps: deps}
}

// Serve listens on the configured address and runs the accept loop until
// ctx is cancelled. Returns nil on graceful shutdown.
func (s *Server) Serve(ctx context.Context) error {
	ln, err := net.Listen("tcp", s.opts.ListenAddr)
	if err != nil {
		return err
	}
	if s.opts.TLSConfig != nil {
		ln = tls.NewListener(ln, s.opts.TLSConfig)
	}
	s.mu.Lock()
	s.ln = ln
	s.mu.Unlock()
	s.deps.Logger.Printf("imap: listening on %s", s.opts.ListenAddr)

	go func() {
		<-ctx.Done()
		_ = ln.Close()
	}()

	var wg sync.WaitGroup
	for {
		conn, err := ln.Accept()
		if err != nil {
			wg.Wait()
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		wg.Add(1)
		go func(c net.Conn) {
			defer wg.Done()
			sess := newSession(c, s.deps)
			sess.run(ctx)
		}(conn)
	}
}

// ServeListener is exposed for tests that want to inject a net.Pipe pair.
func (s *Server) ServeListener(ctx context.Context, ln net.Listener) error {
	s.mu.Lock()
	s.ln = ln
	s.mu.Unlock()
	go func() {
		<-ctx.Done()
		_ = ln.Close()
	}()
	var wg sync.WaitGroup
	for {
		conn, err := ln.Accept()
		if err != nil {
			wg.Wait()
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		wg.Add(1)
		go func(c net.Conn) {
			defer wg.Done()
			sess := newSession(c, s.deps)
			sess.run(ctx)
		}(conn)
	}
}
