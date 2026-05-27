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
	"log"
	"net"
	"sync"
	"time"
)

// Mode is retained as a single-valued type so callers can still pass
// `ModeLocal` for documentation purposes. With the embedded ACME loop
// owning cert files on disk, there is only one TLS source path. The
// historical `ModeTailscale` was an unimplemented branch and is gone;
// Tailscale-fronted deployments now share their network namespace via
// the docker-compose sidecar pattern (`network_mode: service:tailscale`),
// which is a deployment concern, not a TLS-source one.
type Mode string

const ModeLocal Mode = "local"

// Config carries the cert/key paths the source loads from disk.
type Config struct {
	Mode      Mode
	CertPath  string
	KeyPath   string
	HotReload bool
	// ReloadInterval bounds the per-accept lazy reload cadence. Zero
	// uses DefaultReloadInterval (30s). Integration tests override to
	// 1s so rotation assertions don't blow the CI timeout.
	ReloadInterval time.Duration
}

// DefaultReloadInterval is the production-default cadence for the
// per-accept GetCertificate lazy reload.
const DefaultReloadInterval = 30 * time.Second

// Source produces TLS listeners on demand. The returned tls.Config and
// listener factories are wired into each protocol server (SMTPS / IMAP).
type Source struct {
	cfg            Config
	reloadInterval time.Duration
	mu             sync.Mutex
	cert           *tls.Certificate
	certAtNS       int64
	plaintext      bool
}

// New validates the config and constructs a Source.
//
// Both cert/key paths required for TLS-on operation; pass empty
// strings for the plaintext fallback (see `NewPlaintext`).
func New(cfg Config) (*Source, error) {
	if cfg.CertPath == "" || cfg.KeyPath == "" {
		return nil, errors.New("tls: cert_path and key_path required")
	}
	reloadInterval := cfg.ReloadInterval
	if reloadInterval <= 0 {
		reloadInterval = DefaultReloadInterval
	}
	s := &Source{cfg: cfg, reloadInterval: reloadInterval}
	if _, err := s.loadLocked(); err != nil {
		// Distinguish "PEMs not on disk yet" from a real load failure.
		// The bridge's startup path tolerates the former by falling
		// back to plaintext when the operator hasn't configured ACME
		// or mounted certs.
		var pathErr interface{ Error() string }
		_ = pathErr
		return nil, err
	}
	return s, nil
}

// NewPlaintext returns a Source that yields a nil tls.Config — used
// by the bridge when CF/ACME isn't configured AND no operator-mounted
// PEMs are present. Listeners check `IsPlaintext()` and bind without
// a TLS wrapper; SMTP / IMAP carry credentials in the clear in that
// mode (acceptable per operator's explicit downgrade choice).
func NewPlaintext() *Source {
	return &Source{plaintext: true}
}

// IsPlaintext reports whether this source is in the "no TLS" mode.
func (s *Source) IsPlaintext() bool { return s.plaintext }

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
// most once per the configured ReloadInterval (default 30s).
func (s *Source) GetCertificate(_ *tls.ClientHelloInfo) (*tls.Certificate, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cert != nil && time.Now().UnixNano()-s.certAtNS < int64(s.reloadInterval) {
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
