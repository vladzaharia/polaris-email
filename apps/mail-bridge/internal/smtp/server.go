package smtp

import (
	"context"
	"crypto/tls"
	"log"
	"os"
	"strings"
	"sync"
	"time"

	gosmtp "github.com/emersion/go-smtp"
)

// minTLSVersion returns the effective TLS minimum. Defaults to 1.3; an
// operator stuck on a legacy client/library can opt back to 1.2 via the
// BRIDGE_TLS_MIN_VERSION env var.
func minTLSVersion() uint16 {
	switch strings.TrimSpace(os.Getenv("BRIDGE_TLS_MIN_VERSION")) {
	case "1.2", "TLS1.2":
		return tls.VersionTLS12
	default:
		return tls.VersionTLS13
	}
}

// ServerOptions configures the wrapping bridge Server. When TLSCert /
// TLSKey are empty, the server runs in plain mode (no implicit TLS;
// `AllowInsecureAuth = true` so AUTH PLAIN works without TLS).
type ServerOptions struct {
	ListenAddr     string
	Domain         string
	TLSCert        string
	TLSKey         string
	MaxMessageSize int64
	ReadTimeout    time.Duration
	WriteTimeout   time.Duration
}

// Server runs the go-smtp Server. Mode (implicit-TLS vs plain) is
// determined at construction time by whether TLSCert/TLSKey were
// provided.
type Server struct {
	srv     *gosmtp.Server
	opts    ServerOptions
	useTLS  bool
}

// New creates the wrapped server.
func New(opts ServerOptions, be *Backend) *Server {
	if opts.ReadTimeout == 0 {
		opts.ReadTimeout = 60 * time.Second
	}
	if opts.WriteTimeout == 0 {
		opts.WriteTimeout = 60 * time.Second
	}
	srv := gosmtp.NewServer(be)
	srv.Addr = opts.ListenAddr
	srv.Domain = opts.Domain
	srv.MaxMessageBytes = opts.MaxMessageSize
	srv.MaxRecipients = 100
	// go-smtp uses ReadTimeout as the per-command idle window: a client
	// that authenticates and then sits open without sending the next
	// command is dropped after this deadline (the library emits a "421
	// Idle timeout, bye bye"). 60s is plenty for any legitimate client.
	srv.ReadTimeout = opts.ReadTimeout
	srv.WriteTimeout = opts.WriteTimeout

	useTLS := opts.TLSCert != "" && opts.TLSKey != ""
	if useTLS {
		srv.AllowInsecureAuth = false
		// Hot-reload TLS cert on every accept via GetCertificate.
		// MinVersion defaults to TLS 1.3 — TLS 1.2 still permits SHA1-
		// based suites in the wild and Go 1.25's TLS 1.3 implementation
		// enforces AEAD-only ciphers. Operators on a legacy client can
		// opt back to TLS 1.2 via BRIDGE_TLS_MIN_VERSION=1.2.
		cache := &certCache{certPath: opts.TLSCert, keyPath: opts.TLSKey}
		srv.TLSConfig = &tls.Config{
			MinVersion:     minTLSVersion(),
			GetCertificate: cache.Get,
			// SMTP is not an HTTP protocol; advertising `h2` / `http/
			// 1.1` via ALPN invites protocol-confusion attempts. Leave
			// NextProtos empty so ALPN is not offered.
			NextProtos: nil,
		}
	} else {
		// Plain SMTP — accept AUTH PLAIN without TLS. The operator
		// must have an external safeguard (tailnet, VPN, internal
		// network) for this to be safe.
		srv.AllowInsecureAuth = true
	}
	return &Server{srv: srv, opts: opts, useTLS: useTLS}
}

// ListenAndServe blocks serving SMTPS (TLS) or SMTP (plain) depending
// on whether TLS material was provided at construction time.
func (s *Server) ListenAndServe() error {
	if s.useTLS {
		return s.srv.ListenAndServeTLS()
	}
	return s.srv.ListenAndServe()
}

// Shutdown gracefully stops accepting new connections.
func (s *Server) Shutdown(ctx context.Context) error {
	done := make(chan struct{})
	go func() { _ = s.srv.Close(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// certCache reloads the cert from disk if the file mtime changed.
type certCache struct {
	mu       sync.Mutex
	certPath string
	keyPath  string
	loaded   *tls.Certificate
	loadedAt time.Time
}

// Get is suitable for tls.Config.GetCertificate.
func (c *certCache) Get(_ *tls.ClientHelloInfo) (*tls.Certificate, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	// Reload at most once per 30s; lego rotates on order, not on every accept.
	if c.loaded != nil && time.Since(c.loadedAt) < 30*time.Second {
		return c.loaded, nil
	}
	cert, err := tls.LoadX509KeyPair(c.certPath, c.keyPath)
	if err != nil {
		if c.loaded != nil {
			log.Printf("smtp: cert reload failed, using cached: %v", err)
			return c.loaded, nil
		}
		return nil, err
	}
	c.loaded = &cert
	c.loadedAt = time.Now()
	return c.loaded, nil
}
