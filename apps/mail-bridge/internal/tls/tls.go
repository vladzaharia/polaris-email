// Package tls assembles TLS sources for the mail-bridge listeners.
//
// Two first-class modes (per memory `feedback_tailscale_sidecar.md`):
//
//   - mode = "local"      : load cert/key PEMs from disk, optional hot-reload
//     via fsnotify watch (stubbed — see TODO below).
//   - mode = "tailscale"  : delegate to `tsnet.Server.ListenTLS`.
//
// The tsnet path is intentionally stubbed in this slice: the dependency
// pulls in a large chunk of the Tailscale daemon and is gated on
// upstream-cert provisioning that varies per deployment. See
// TODO(L.5) below.
package tls

import (
	"crypto/tls"
	"errors"
	"fmt"
	"log"
	"net"
	"sync"
	"time"
)

// Mode is the TLS source selector.
type Mode string

const (
	ModeLocal     Mode = "local"
	ModeTailscale Mode = "tailscale"
)

// ErrTailscaleUnsupported is returned by New when Mode == ModeTailscale and
// the build does not include tsnet integration. Callers must treat this as
// a fatal startup error — falling back to plaintext IMAP/SMTPS would expose
// LOGIN over the wire.
var ErrTailscaleUnsupported = errors.New("tls.tailscale: tsnet integration not compiled into this build (future enhancement); use BRIDGE_TLS_MODE=local with mounted PEMs, or run behind a tailscale-serve sidecar")

// Config selects a Mode plus mode-specific knobs.
type Config struct {
	Mode      Mode
	CertPath  string
	KeyPath   string
	HotReload bool
	// TailscaleHostname is the MagicDNS hostname for tsnet.ListenTLS.
	TailscaleHostname string
	// TailscaleDir is the tsnet state directory.
	TailscaleDir string
}

// Source produces TLS listeners on demand. The returned tls.Config and
// listener factories are wired into each protocol server (SMTPS / IMAP).
type Source struct {
	cfg      Config
	mu       sync.Mutex
	cert     *tls.Certificate
	certAtNS int64
}

// New validates the config and constructs a Source.
func New(cfg Config) (*Source, error) {
	switch cfg.Mode {
	case ModeLocal:
		if cfg.CertPath == "" || cfg.KeyPath == "" {
			return nil, errors.New("tls.local: cert_path and key_path required")
		}
		s := &Source{cfg: cfg}
		if _, err := s.loadLocked(); err != nil {
			return nil, err
		}
		return s, nil
	case ModeTailscale:
		// tsnet.ListenTLS is a future enhancement (TODO(L.5)): the tsnet dep
		// adds ~30MB to the binary and requires TS_AUTHKEY at runtime, so we
		// keep it out of this build. We return ErrTailscaleUnsupported here;
		// callers MUST treat it as fatal and abort startup, never silently
		// fall back to plaintext (the Phase 2d audit caught a path where
		// main.go logged the error and kept going, which left port 993 in
		// `InsecureAuth` mode against the public internet).
		return nil, ErrTailscaleUnsupported
	default:
		return nil, fmt.Errorf("tls: unknown mode %q", cfg.Mode)
	}
}

// TLSConfig returns a *tls.Config wired to this source's GetCertificate.
func (s *Source) TLSConfig() *tls.Config {
	return &tls.Config{
		MinVersion:     tls.VersionTLS12,
		GetCertificate: s.GetCertificate,
		NextProtos:     []string{"h2", "http/1.1"},
	}
}

// GetCertificate is the tls.Config.GetCertificate callback. Reloads at
// most once every 30s.
func (s *Source) GetCertificate(_ *tls.ClientHelloInfo) (*tls.Certificate, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cert != nil && time.Now().UnixNano()-s.certAtNS < int64(30*time.Second) {
		return s.cert, nil
	}
	c, err := s.loadLocked()
	if err != nil && s.cert != nil {
		log.Printf("tls: reload failed, using cached cert: %v", err)
		return s.cert, nil
	}
	return c, err
}

func (s *Source) loadLocked() (*tls.Certificate, error) {
	c, err := tls.LoadX509KeyPair(s.cfg.CertPath, s.cfg.KeyPath)
	if err != nil {
		return nil, err
	}
	s.cert = &c
	s.certAtNS = time.Now().UnixNano()
	return s.cert, nil
}

// Listen returns a tls.Listener bound to addr.
func (s *Source) Listen(network, addr string) (net.Listener, error) {
	l, err := net.Listen(network, addr)
	if err != nil {
		return nil, err
	}
	return tls.NewListener(l, s.TLSConfig()), nil
}

// TODO(production): fsnotify watcher on CertPath/KeyPath that pre-emptively
// calls loadLocked() on file change. For now the 30s reload cadence in
// GetCertificate suffices for cert rotation.
