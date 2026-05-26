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
// heartbeat response. Heartbeat v2.1 (migration 0013) splits each
// protocol into its encrypted + unencrypted variants — the bridge
// runs SMTPS + SMTP + IMAPS + IMAP listeners independently.
type Settings struct {
	Version int

	SMTPSEnabled bool
	SMTPSPort    int
	SMTPEnabled  bool
	SMTPPort     int

	IMAPSEnabled bool
	IMAPSPort    int
	IMAPEnabled  bool
	IMAPPort     int

	// Shared TLS source for SMTPS + IMAPS. "auto" = embedded ACME;
	// "manual" = operator-supplied PEMs at TLSCertPath/TLSKeyPath.
	TLSSource string

	MaxMessageSize  int64
	MaxIMAPSessions int
	LogLevel        string
}

// Deps bundles every dependency the supervisor needs to instantiate
// listeners. main.go builds them once and hands them in. Listener
// addresses come from Settings (per-protocol port), not Deps — only
// dependencies that don't change across reconciles live here.
type Deps struct {
	// SMTP
	SMTPBackend *dsmtp.Backend
	SMTPDomain  string
	TLSCertPath string
	TLSKeyPath  string
	// IMAP
	IMAPBackend *bridgeimap.Backend
	// Webhook receiver
	WebhookHandler    *webhook.Handler
	WebhookListenAddr string
	// Shared
	TLSSource   *bridgetls.Source
	LogLevelVar *slog.LevelVar // optional; supervisor flips this on log_level apply
}

// Supervisor coordinates the three listeners. Methods are safe to call
// concurrently from the heartbeat goroutine.
type Supervisor struct {
	mu        sync.Mutex
	deps      Deps
	current   Settings
	started   bool
	suspended bool

	smtps   *smtpHandle // encrypted (TLS)
	smtp    *smtpHandle // plain
	imaps   *imapHandle // encrypted
	imap    *imapHandle // plain
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

	// Restart-required diffs: ports + TLS source + message size + IMAP
	// session cap. Those are baked into the listener's TLS config /
	// SMTP server options at construction time and a clean re-bind on
	// a fresh process is simpler than a hot rebind.
	if next.SMTPSPort != s.current.SMTPSPort ||
		next.SMTPPort != s.current.SMTPPort ||
		next.IMAPSPort != s.current.IMAPSPort ||
		next.IMAPPort != s.current.IMAPPort ||
		next.TLSSource != s.current.TLSSource ||
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
		s.current = next // updated first so start*Locked sees the new flags
		if err := s.reconcileLocked(ctx); err != nil {
			return false, err
		}
		return false, nil
	}

	s.current = next
	return false, nil
}

// reconcileLocked starts or stops each listener variant so the running
// set matches `s.current`. Called by Apply (hot-reload) and bringUp
// (initial Start / Resume).
func (s *Supervisor) reconcileLocked(ctx context.Context) error {
	type entry struct {
		want bool
		on   bool
		start func(context.Context) error
		stop  func(context.Context)
	}
	entries := []entry{
		{s.current.SMTPSEnabled, s.smtps != nil, s.startSMTPSLocked, s.stopSMTPSLocked},
		{s.current.SMTPEnabled, s.smtp != nil, s.startSMTPLocked, s.stopSMTPLocked},
		{s.current.IMAPSEnabled, s.imaps != nil, s.startIMAPSLocked, s.stopIMAPSLocked},
		{s.current.IMAPEnabled, s.imap != nil, s.startIMAPLocked, s.stopIMAPLocked},
	}
	for _, e := range entries {
		switch {
		case e.want && !e.on:
			if err := e.start(ctx); err != nil {
				return err
			}
		case !e.want && e.on:
			e.stop(ctx)
		}
	}
	return nil
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
	if err := s.reconcileLocked(ctx); err != nil {
		return err
	}
	if err := s.startWebhookLocked(ctx); err != nil {
		return fmt.Errorf("webhook: %w", err)
	}
	return nil
}

func (s *Supervisor) tearDownLocked(ctx context.Context) {
	s.stopSMTPSLocked(ctx)
	s.stopSMTPLocked(ctx)
	s.stopIMAPSLocked(ctx)
	s.stopIMAPLocked(ctx)
	s.stopWebhookLocked(ctx)
}

// --- SMTP ---

type smtpHandle struct {
	srv  *dsmtp.Server
	done chan struct{}
	port int
	tls  bool
}

// startSMTPSLocked binds the encrypted SMTPS variant. Listens on
// `:<smtps_port>`; TLS material comes from the shared cert dir.
func (s *Supervisor) startSMTPSLocked(_ context.Context) error {
	if s.smtps != nil || s.deps.SMTPBackend == nil {
		return nil
	}
	addr := fmt.Sprintf(":%d", s.current.SMTPSPort)
	srv := dsmtp.New(
		dsmtp.ServerOptions{
			ListenAddr:     addr,
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
			log.Printf("supervisor: smtps server exited: %v", err)
		}
	}()
	s.smtps = &smtpHandle{srv: srv, done: done, port: s.current.SMTPSPort, tls: true}
	log.Printf("supervisor: smtps listening on %s", addr)
	return nil
}

func (s *Supervisor) stopSMTPSLocked(ctx context.Context) {
	stopSMTP(&s.smtps, ctx, "smtps")
}

// startSMTPLocked binds the plain SMTP variant. Listens on
// `:<smtp_port>`; no TLS, AUTH PLAIN over plaintext (operator's
// responsibility to gate via tailnet / private network).
func (s *Supervisor) startSMTPLocked(_ context.Context) error {
	if s.smtp != nil || s.deps.SMTPBackend == nil {
		return nil
	}
	addr := fmt.Sprintf(":%d", s.current.SMTPPort)
	srv := dsmtp.New(
		dsmtp.ServerOptions{
			ListenAddr:     addr,
			Domain:         s.deps.SMTPDomain,
			MaxMessageSize: s.current.MaxMessageSize,
			// TLSCert/TLSKey empty → plain mode (AllowInsecureAuth on).
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
	s.smtp = &smtpHandle{srv: srv, done: done, port: s.current.SMTPPort, tls: false}
	log.Printf("supervisor: smtp listening on %s (PLAIN)", addr)
	return nil
}

func (s *Supervisor) stopSMTPLocked(ctx context.Context) {
	stopSMTP(&s.smtp, ctx, "smtp")
}

func stopSMTP(handle **smtpHandle, ctx context.Context, label string) {
	h := *handle
	if h == nil {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	shutCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_ = h.srv.Shutdown(shutCtx)
	<-h.done
	*handle = nil
	log.Printf("supervisor: %s stopped", label)
}

// --- IMAP ---

type imapHandle struct {
	srv  *imapserver.Server
	ln   net.Listener
	done chan struct{}
	port int
	tls  bool
}

// startIMAPSLocked binds the encrypted IMAPS variant on `:<imaps_port>`.
func (s *Supervisor) startIMAPSLocked(_ context.Context) error {
	if s.imaps != nil || s.deps.IMAPBackend == nil {
		return nil
	}
	tlsCfg := tlsConfigFor(s.deps.TLSSource)
	if tlsCfg == nil {
		log.Printf("supervisor: imaps enabled but no TLS source available — skipping")
		return nil
	}
	addr := fmt.Sprintf(":%d", s.current.IMAPSPort)
	handle, err := startIMAPListener(s.deps.IMAPBackend, addr, tlsCfg)
	if err != nil {
		return err
	}
	handle.port = s.current.IMAPSPort
	handle.tls = true
	s.imaps = handle
	log.Printf("supervisor: imaps listening on %s", addr)
	return nil
}

func (s *Supervisor) stopIMAPSLocked(_ context.Context) {
	stopIMAP(&s.imaps, "imaps")
}

// startIMAPLocked binds the plain IMAP variant on `:<imap_port>`.
func (s *Supervisor) startIMAPLocked(_ context.Context) error {
	if s.imap != nil || s.deps.IMAPBackend == nil {
		return nil
	}
	addr := fmt.Sprintf(":%d", s.current.IMAPPort)
	handle, err := startIMAPListener(s.deps.IMAPBackend, addr, nil)
	if err != nil {
		return err
	}
	handle.port = s.current.IMAPPort
	handle.tls = false
	s.imap = handle
	log.Printf("supervisor: imap listening on %s (PLAIN)", addr)
	return nil
}

func (s *Supervisor) stopIMAPLocked(_ context.Context) {
	stopIMAP(&s.imap, "imap")
}

func startIMAPListener(
	backend *bridgeimap.Backend,
	addr string,
	tlsCfg *tls.Config,
) (*imapHandle, error) {
	srv := imapserver.New(&imapserver.Options{
		NewSession: backend.NewSession,
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
		ln, err = net.Listen("tcp", addr)
	} else {
		ln, err = tls.Listen("tcp", addr, tlsCfg)
	}
	if err != nil {
		return nil, err
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		if err := srv.Serve(ln); err != nil {
			log.Printf("supervisor: imap server exited: %v", err)
		}
	}()
	return &imapHandle{srv: srv, ln: ln, done: done}, nil
}

func stopIMAP(handle **imapHandle, label string) {
	h := *handle
	if h == nil {
		return
	}
	_ = h.ln.Close()
	_ = h.srv.Close()
	<-h.done
	*handle = nil
	log.Printf("supervisor: %s stopped", label)
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
