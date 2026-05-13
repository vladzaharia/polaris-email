// Command polaris-daemon is the on-prem SMTP submission daemon.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/vladzaharia/polaris-email/apps/submission-daemon/internal/audit"
	"github.com/vladzaharia/polaris-email/apps/submission-daemon/internal/config"
	"github.com/vladzaharia/polaris-email/apps/submission-daemon/internal/credstore"
	"github.com/vladzaharia/polaris-email/apps/submission-daemon/internal/forwarder"
	dsmtp "github.com/vladzaharia/polaris-email/apps/submission-daemon/internal/smtp"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	log.Printf("polaris-daemon starting: name=%s id=%s listen=%s", cfg.DaemonName, cfg.DaemonID, cfg.ListenAddr)

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
					log.Printf("polaris-daemon: ready (mirror_version=%d)", store.MirrorVersion())
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
		log.Printf("polaris-daemon: signal %s, shutting down", s)
		shutCtx, c := context.WithTimeout(context.Background(), 10*time.Second)
		defer c()
		_ = srv.Shutdown(shutCtx)
		cancel()
	}()

	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("smtp server: %v", err)
	}
}
