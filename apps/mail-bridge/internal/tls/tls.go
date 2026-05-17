// Package tls assembles TLS sources for the mail-bridge listeners.
//
// Two first-class deployment modes (both supported equally — neither is
// the canonical default; pick the one that matches your network model):
//
//   - mode = "local"      : load cert/key PEMs from disk; certs hot-reload
//     on the per-accept 30s reload cadence in GetCertificate, which is
//     sufficient for ACME rotations that happen at most monthly.
//   - mode = "tailscale"  : delegate to `tsnet.Server.ListenTLS`. Not
//     compiled into this build — see ErrTailscaleUnsupported.
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
		// tsnet.ListenTLS is a future enhancement: the tsnet dependency adds
		// ~30MB to the binary and requires TS_AUTHKEY at runtime, so it
		// stays out of the default build. Callers MUST treat
		// ErrTailscaleUnsupported as fatal and abort startup — never
		// silently fall back to plaintext, which would leave SMTPS / IMAP
		// AUTH credentials traversing the public internet in the clear.
		return nil, ErrTailscaleUnsupported
	default:
		return nil, fmt.Errorf("tls: unknown mode %q", cfg.Mode)
	}
}

// TLSConfig returns a *tls.Config wired to this source's GetCertificate.
// MinVersion defaults to TLS 1.3 (matching the smtp.Server path); ALPN
// is intentionally empty because the mail-bridge listeners are SMTP/IMAP,
// not HTTP — advertising h2/http/1.1 invites protocol-confusion attempts.
func (s *Source) TLSConfig() *tls.Config {
	return &tls.Config{
		MinVersion:     tls.VersionTLS13,
		GetCertificate: s.GetCertificate,
		NextProtos:     nil,
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

// Cert hot-reload uses the 30s cadence in GetCertificate rather than an
// fsnotify watcher. ACME rotations happen on the order of months and the
// 30s lazy reload is bounded by the cipher-suite handshake count, not a
// real-time SLA — adding fsnotify here would burn a goroutine for the
// rest of the bridge's life to save at most 30s on the rare rotation.
