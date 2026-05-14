// Command polaris-bridge is the on-prem polaris mail bridge.
//
// In this slice (L.1) it ships only the SMTPS submission listener (port 465),
// inherited from the renamed `apps/submission-daemon`. The IMAP4rev2 (:993)
// and JMAP (:443) listeners arrive in slice L.2; backend endpoints (Email
// changes, credential CRUD) land in slice L.3.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/audit"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/config"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/credstore"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/forwarder"
	dsmtp "github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/smtp"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	log.Printf("polaris-bridge starting: name=%s id=%s listen=%s", cfg.DaemonName, cfg.DaemonID, cfg.ListenAddr)

	store, err := credstore.Open(cfg.SQLitePath)
	if err != nil {
		log.Fatalf("credstore open: %v", err)
	}
	defer store.Close()

	auditLog, err := audit.New(cfg.AuditLogPath)
	if err != nil {
		log.Fatalf("audit open: %v", err)
	}
	defer auditLog.Close()

	httpClient := &http.Client{Timeout: 60 * time.Second}

	poller := credstore.NewPoller(credstore.PollerConfig{
		APIURL:             cfg.APIURL,
		HMACKey:            cfg.HMACKey,
		DaemonID:           cfg.DaemonID,
		AccessClientID:     cfg.AccessClientID,
		AccessClientSecret: cfg.AccessClientSecret,
		Interval:           cfg.PollInterval,
	}, store)

	fwd := forwarder.New(forwarder.Config{
		APIURL:             cfg.APIURL,
		HMACKey:            cfg.HMACKey,
		DaemonID:           cfg.DaemonID,
		AccessClientID:     cfg.AccessClientID,
		AccessClientSecret: cfg.AccessClientSecret,
		HTTPClient:         httpClient,
	})

	be := &dsmtp.Backend{Deps: dsmtp.Deps{
		Store:          store,
		Forwarder:      fwd,
		Audit:          auditLog,
		MaxMessageSize: cfg.MaxMessageSize,
	}}

	srv := dsmtp.New(dsmtp.ServerOptions{
		ListenAddr:     cfg.ListenAddr,
		Domain:         cfg.DaemonName,
		TLSCert:        cfg.TLSCert,
		TLSKey:         cfg.TLSKey,
		MaxMessageSize: cfg.MaxMessageSize,
	}, be)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go poller.Run(ctx)

	// Heartbeat: log readiness once.
	go func() {
		t := time.NewTicker(2 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if poller.Ready() {
					log.Printf("polaris-bridge: ready (mirror_version=%d)", store.MirrorVersion())
					return
				}
			}
		}
	}()

	// Signals.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		s := <-sigCh
		log.Printf("polaris-bridge: signal %s, shutting down", s)
		shutCtx, c := context.WithTimeout(context.Background(), 10*time.Second)
		defer c()
		_ = srv.Shutdown(shutCtx)
		cancel()
	}()

	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("smtp server: %v", err)
	}
}
