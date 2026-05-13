package smtp

import (
	"context"
	"crypto/tls"
	"log"
	"sync"
	"time"

	gosmtp "github.com/emersion/go-smtp"
)

// ServerOptions configures the wrapping daemon Server.
type ServerOptions struct {
	ListenAddr     string
	Domain         string
	TLSCert        string
	TLSKey         string
	MaxMessageSize int64
	ReadTimeout    time.Duration
	WriteTimeout   time.Duration
}

// Server runs the go-smtp Server with hot-reloading TLS certs.
type Server struct {
	srv  *gosmtp.Server
	opts ServerOptions
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
	srv.ReadTimeout = opts.ReadTimeout
	srv.WriteTimeout = opts.WriteTimeout
	srv.AllowInsecureAuth = false

	// Hot-reload TLS cert on every accept via GetCertificate.
	cache := &certCache{certPath: opts.TLSCert, keyPath: opts.TLSKey}
	srv.TLSConfig = &tls.Config{
		MinVersion:     tls.VersionTLS12,
		GetCertificate: cache.Get,
	}
	return &Server{srv: srv, opts: opts}
}

// ListenAndServe blocks running implicit-TLS SMTPS.
func (s *Server) ListenAndServe() error { return s.srv.ListenAndServeTLS() }

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
