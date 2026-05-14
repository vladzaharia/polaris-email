// Package jmap implements a hand-rolled JMAP server (RFC 8620 core +
// RFC 8621 mail + RFC 8887 WebSocket) atop net/http.
//
// This is a functional skeleton — every method in scope returns valid JMAP
// shape against the polaris SDK, but production-grade error matrices,
// queryFilterCondition coverage, and blob storage are TODO(production).
package jmap

import (
	"context"
	"crypto/tls"
	"log"
	"net"
	"net/http"

	polarissdk "github.com/polaris-email/polaris-sdk-go"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/push"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/store"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/webhook"
)

// Deps wires the JMAP server to bridge subsystems.
type Deps struct {
	Client         *polarissdk.Client
	Mirror         *store.Mirror
	Push           *push.Manager
	WebhookHandler *webhook.Handler
	Logger         *log.Logger
}

// Options configure the listener.
type Options struct {
	ListenAddr string
	TLSConfig  *tls.Config
	// SessionURL is the absolute URL advertised in the session object's
	// apiUrl / downloadUrl / uploadUrl fields.
	SessionURL string
}

// Server is the JMAP HTTP server.
type Server struct {
	opts Options
	deps Deps
	mux  *http.ServeMux
	srv  *http.Server
}

// New constructs a Server. Serve actually binds the listener.
func New(opts Options, deps Deps) *Server {
	if deps.Logger == nil {
		deps.Logger = log.Default()
	}
	s := &Server{opts: opts, deps: deps, mux: http.NewServeMux()}
	s.mux.HandleFunc("GET /.well-known/jmap", s.handleWellKnown)
	s.mux.HandleFunc("GET /jmap/session", s.handleSession)
	s.mux.HandleFunc("POST /jmap/api", s.handleAPI)
	s.mux.HandleFunc("GET /jmap/download/{accountId}/{blobId}/{name}", s.handleDownload)
	s.mux.HandleFunc("POST /jmap/upload/{accountId}", s.handleUpload)
	s.mux.HandleFunc("GET /jmap/ws", s.handleWS)
	s.mux.HandleFunc("GET /jmap/eventsource", s.handleSSE)
	// Internal webhook receiver — polaris posts message.received here.
	if deps.WebhookHandler != nil {
		s.mux.HandleFunc("POST /internal/webhook/message-received", deps.WebhookHandler.ServeHTTP)
	}
	return s
}

// Handler exposes the mux for tests / for embedding behind a reverse proxy.
func (s *Server) Handler() http.Handler { return s.mux }

// Serve binds the listener and blocks until ctx is cancelled.
func (s *Server) Serve(ctx context.Context) error {
	s.srv = &http.Server{
		Addr:      s.opts.ListenAddr,
		Handler:   s.mux,
		TLSConfig: s.opts.TLSConfig,
	}
	ln, err := net.Listen("tcp", s.opts.ListenAddr)
	if err != nil {
		return err
	}
	if s.opts.TLSConfig != nil {
		ln = tls.NewListener(ln, s.opts.TLSConfig)
	}
	go func() {
		<-ctx.Done()
		_ = s.srv.Shutdown(context.Background())
	}()
	s.deps.Logger.Printf("jmap: listening on %s", s.opts.ListenAddr)
	if err := s.srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}
