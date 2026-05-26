// Package listeners owns the lifecycle of the bridge's three serving
// processes: SMTPS (:465), IMAP4 (:993), and the inbound webhook
// receiver (:8080). It exposes Suspend/Resume so the heartbeat ticker
// can suspend listeners in response to an `enabled: false` signal
// without exiting the process — the heartbeat goroutine stays alive
// and the bridge resumes on the next `enabled: true`.
//
// Apply() takes a settings snapshot and reports whether the change is
// satisfiable in-place. Phase 2 keeps the hot-reload list narrow:
//
//   * smtp_enabled / imap_enabled toggles  → hot (start or stop)
//   * log_level                            → hot (slog level slider)
//   * any other change (ports, TLS mode,   → restartRequired = true
//     limits)                                Caller exits; compose
//                                            restarts the process so
//                                            it re-reads its env.
//
// Boot-time ports + TLS mode still come from env in Phase 2; the
// server-side `bridge_settings.smtp_port` etc. are tracked for the
// panel display and future Phase 3 settings-driven listener binding.
package listeners

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapserver"

	bridgeimap "github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/imap"
	dsmtp "github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/smtp"
	bridgetls "github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/tls"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/webhook"
)

// Settings is the bridge's view of `BridgeSettings` from the server's
// heartbeat response. Phase 2 acts on a narrow subset of these.
type Settings struct {
	Version         int
	SMTPEnabled     bool
	IMAPEnabled     bool
	SMTPPort        int
	IMAPPort        int
	SMTPTLSMode     string // "auto" | "manual" | "off"
	IMAPTLSMode     string
	MaxMessageSize  int64
	MaxIMAPSessions int
	LogLevel        string
}

// Deps bundles every dependency the supervisor needs to instantiate
// listeners. main.go builds them once and hands them in.
type Deps struct {
	// SMTP
	SMTPBackend    *dsmtp.Backend
	SMTPDomain     string
	SMTPListenAddr string
	TLSCertPath    string
	TLSKeyPath     string
	// IMAP
	IMAPBackend    *bridgeimap.Backend
	IMAPListenAddr string
	// Webhook receiver
	WebhookHandler    *webhook.Handler
	WebhookListenAddr string
	// Shared
	TLSSource    *bridgetls.Source
	LogLevelVar  *slog.LevelVar // optional; supervisor flips this on log_level apply
}

// Supervisor coordinates the three listeners. Methods are safe to call
// concurrently from the heartbeat goroutine.
type Supervisor struct {
	mu        sync.Mutex
	deps      Deps
	current   Settings
	started   bool
	suspended bool

	smtp    *smtpHandle
	imap    *imapHandle
	webhook *webhookHandle
}

// New builds a fresh supervisor. Settings are seeded by Start.
func New(deps Deps) *Supervisor {
	return &Supervisor{deps: deps}
}

// Start binds the listeners according to `initial` and begins serving.
// Returns on first bind error; partial successes are torn down.
func (s *Supervisor) Start(ctx context.Context, initial Settings) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.started {
		return errors.New("supervisor: already started")
	}
	s.current = initial
	if err := s.bringUpLocked(ctx); err != nil {
		s.tearDownLocked(context.Background())
		return err
	}
	s.started = true
	return nil
}

// Suspend stops the SMTP + IMAP + webhook listeners but keeps the
// supervisor's state. Resume() brings them back. Idempotent.
func (s *Supervisor) Suspend(ctx context.Context) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.started || s.suspended {
		return
	}
	log.Printf("supervisor: suspending listeners (disabled by admin)")
	s.tearDownLocked(ctx)
	s.suspended = true
}

// Resume re-binds the listeners after Suspend. Idempotent.
func (s *Supervisor) Resume(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.started || !s.suspended {
		return nil
	}
	log.Printf("supervisor: resuming listeners (re-enabled)")
	if err := s.bringUpLocked(ctx); err != nil {
		return err
	}
	s.suspended = false
	return nil
}

// Apply diffs `next` against the current settings. Returns
// restartRequired=true when the change can't be hot-applied (port or
// TLS mode change); the caller (heartbeat ticker) should exit so
// compose brings the process back with the new config.
//
// Phase 2 hot-applied changes:
//   * smtp_enabled / imap_enabled toggle
//   * log_level (via the shared *slog.LevelVar, if Deps provides one)
//
// Everything else flags restart-required.
func (s *Supervisor) Apply(ctx context.Context, next Settings) (restartRequired bool, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.started {
		return false, errors.New("supervisor: not started")
	}
	if next.Version <= s.current.Version {
		return false, nil
	}

	// Restart-required diffs: ports + TLS modes + message size + IMAP
	// session cap. Those are baked into the listener's TLS config /
	// SMTP server options at construction time and a clean re-bind on
	// a fresh process is simpler than a hot rebind.
	if next.SMTPPort != s.current.SMTPPort ||
		next.IMAPPort != s.current.IMAPPort ||
		next.SMTPTLSMode != s.current.SMTPTLSMode ||
		next.IMAPTLSMode != s.current.IMAPTLSMode ||
		next.MaxMessageSize != s.current.MaxMessageSize ||
		next.MaxIMAPSessions != s.current.MaxIMAPSessions {
		return true, nil
	}

	if next.LogLevel != s.current.LogLevel && s.deps.LogLevelVar != nil {
		s.deps.LogLevelVar.Set(parseLogLevel(next.LogLevel))
		log.Printf("supervisor: log_level → %s", next.LogLevel)
	}

	// Skip listener work when suspended — Resume() will replay with
	// the new current settings.
	if !s.suspended {
		if next.SMTPEnabled != s.current.SMTPEnabled {
			if next.SMTPEnabled {
				if err := s.startSMTPLocked(ctx); err != nil {
					return false, err
				}
			} else {
				s.stopSMTPLocked(ctx)
			}
		}
		if next.IMAPEnabled != s.current.IMAPEnabled {
			if next.IMAPEnabled {
				if err := s.startIMAPLocked(ctx); err != nil {
					return false, err
				}
			} else {
				s.stopIMAPLocked(ctx)
			}
		}
	}

	s.current = next
	return false, nil
}

// Shutdown stops every listener and marks the supervisor done. Call
// from the main shutdown path (SIGTERM).
func (s *Supervisor) Shutdown(ctx context.Context) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tearDownLocked(ctx)
	s.started = false
	s.suspended = false
}

// ---------- internals ----------

func (s *Supervisor) bringUpLocked(ctx context.Context) error {
	if s.current.SMTPEnabled {
		if err := s.startSMTPLocked(ctx); err != nil {
			return fmt.Errorf("smtp: %w", err)
		}
	}
	if s.current.IMAPEnabled {
		if err := s.startIMAPLocked(ctx); err != nil {
			return fmt.Errorf("imap: %w", err)
		}
	}
	if err := s.startWebhookLocked(ctx); err != nil {
		return fmt.Errorf("webhook: %w", err)
	}
	return nil
}

func (s *Supervisor) tearDownLocked(ctx context.Context) {
	s.stopSMTPLocked(ctx)
	s.stopIMAPLocked(ctx)
	s.stopWebhookLocked(ctx)
}

// --- SMTP ---

type smtpHandle struct {
	srv  *dsmtp.Server
	done chan struct{}
}

func (s *Supervisor) startSMTPLocked(_ context.Context) error {
	if s.smtp != nil {
		return nil
	}
	if s.deps.SMTPBackend == nil {
		log.Printf("supervisor: SMTP backend not wired; skipping start")
		return nil
	}
	srv := dsmtp.New(
		dsmtp.ServerOptions{
			ListenAddr:     s.deps.SMTPListenAddr,
			Domain:         s.deps.SMTPDomain,
			TLSCert:        s.deps.TLSCertPath,
			TLSKey:         s.deps.TLSKeyPath,
			MaxMessageSize: s.current.MaxMessageSize,
		},
		s.deps.SMTPBackend,
	)
	done := make(chan struct{})
	go func() {
		defer close(done)
		if err := srv.ListenAndServe(); err != nil {
			log.Printf("supervisor: smtp server exited: %v", err)
		}
	}()
	s.smtp = &smtpHandle{srv: srv, done: done}
	log.Printf("supervisor: smtp listening on %s", s.deps.SMTPListenAddr)
	return nil
}

func (s *Supervisor) stopSMTPLocked(ctx context.Context) {
	if s.smtp == nil {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	shutCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_ = s.smtp.srv.Shutdown(shutCtx)
	<-s.smtp.done
	s.smtp = nil
	log.Printf("supervisor: smtp stopped")
}

// --- IMAP ---

type imapHandle struct {
	srv  *imapserver.Server
	ln   net.Listener
	done chan struct{}
}

func (s *Supervisor) startIMAPLocked(_ context.Context) error {
	if s.imap != nil {
		return nil
	}
	if s.deps.IMAPBackend == nil {
		log.Printf("supervisor: IMAP backend not wired; skipping start")
		return nil
	}
	tlsCfg := tlsConfigFor(s.deps.TLSSource)
	srv := imapserver.New(&imapserver.Options{
		NewSession: s.deps.IMAPBackend.NewSession,
		Caps: imap.CapSet{
			imap.CapIMAP4rev2:     {},
			imap.CapIMAP4rev1:     {},
			imap.AuthCap("PLAIN"): {},
		},
		TLSConfig:    tlsCfg,
		InsecureAuth: tlsCfg == nil,
	})
	var ln net.Listener
	var err error
	if tlsCfg == nil {
		ln, err = net.Listen("tcp", s.deps.IMAPListenAddr)
	} else {
		ln, err = tls.Listen("tcp", s.deps.IMAPListenAddr, tlsCfg)
	}
	if err != nil {
		return err
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		if err := srv.Serve(ln); err != nil {
			log.Printf("supervisor: imap server exited: %v", err)
		}
	}()
	s.imap = &imapHandle{srv: srv, ln: ln, done: done}
	log.Printf("supervisor: imap listening on %s (tls=%v)", s.deps.IMAPListenAddr, tlsCfg != nil)
	return nil
}

func (s *Supervisor) stopIMAPLocked(_ context.Context) {
	if s.imap == nil {
		return
	}
	_ = s.imap.ln.Close()
	_ = s.imap.srv.Close()
	<-s.imap.done
	s.imap = nil
	log.Printf("supervisor: imap stopped")
}

// --- Webhook receiver ---

type webhookHandle struct {
	srv  *http.Server
	done chan struct{}
}

func (s *Supervisor) startWebhookLocked(_ context.Context) error {
	if s.webhook != nil {
		return nil
	}
	if s.deps.WebhookHandler == nil {
		return nil
	}
	mux := http.NewServeMux()
	mux.Handle(s.deps.WebhookHandler.Path, s.deps.WebhookHandler)
	srv := &http.Server{
		Addr:              s.deps.WebhookListenAddr,
		Handler:           mux,
		ReadHeaderTimeout: 15 * time.Second,
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("supervisor: webhook server exited: %v", err)
		}
	}()
	s.webhook = &webhookHandle{srv: srv, done: done}
	log.Printf("supervisor: webhook listening on %s", s.deps.WebhookListenAddr)
	return nil
}

func (s *Supervisor) stopWebhookLocked(ctx context.Context) {
	if s.webhook == nil {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	shutCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_ = s.webhook.srv.Shutdown(shutCtx)
	<-s.webhook.done
	s.webhook = nil
	log.Printf("supervisor: webhook stopped")
}

// tlsConfigFor mirrors the helper in main.go — plaintext sources
// return nil so callers know to bind a raw TCP listener.
func tlsConfigFor(src *bridgetls.Source) *tls.Config {
	if src == nil || src.IsPlaintext() {
		return nil
	}
	return &tls.Config{
		MinVersion:     tls.VersionTLS12,
		GetCertificate: src.GetCertificate,
	}
}

func parseLogLevel(s string) slog.Level {
	switch s {
	case "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
