// Command polaris-bridge is the on-prem polaris mail bridge.
//
// One binary spawns two concurrent listeners:
//
//   - SMTPS submission   (:465, RFC 6409 / 8314)
//   - IMAP4rev2          (:993, RFC 9051 subset)
//
// Both share one auth lookup (mailbox_credentials), one bridge-local
// SQLite mirror, and one push.Manager fanning state-change events out to
// IMAP IDLE subscribers.
package main

import (
	"context"
	"crypto/tls"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	polarissdk "github.com/polaris-email/polaris-sdk-go"

	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/audit"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/config"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/credstore"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/forwarder"
	bridgeimap "github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/imap"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/push"
	dsmtp "github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/smtp"
	mirrorstore "github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/store"
	bridgetls "github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/tls"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/webhook"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	log.Printf("polaris-bridge starting: name=%s id=%s", cfg.DaemonName, cfg.DaemonID)

	// Shared subsystems.
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

	// Polaris SDK client used by the IMAP listener + push.
	sdkClient := polarissdk.NewClient(cfg.APIURL)
	sdkClient.DaemonID = cfg.DaemonID
	sdkClient.DaemonSecret = cfg.HMACKey

	// Bridge-local SQLite mirror.
	mirrorDB, err := openMirror(cfg)
	if err != nil {
		log.Fatalf("mirror open: %v", err)
	}
	defer mirrorDB.Close()

	pushMgr := push.New()

	// Webhook subscription bootstrap. Auto-registers a sub on polaris that
	// posts to this bridge's /internal/webhook/message-received path.
	publicURL := os.Getenv("BRIDGE_PUBLIC_URL")
	if publicURL == "" {
		publicURL = "https://localhost"
	}
	bootstrap := &webhook.Bootstrap{
		Client:    sdkClient,
		PublicURL: publicURL,
		Path:      "/internal/webhook/message-received",
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go poller.Run(ctx)

	// Bootstrap webhook subs in the background — once mailboxes are
	// known we'll register one per mailbox.
	go func() {
		// Pragmatic stub: enumerate mailboxes from polaris and register
		// subs for each. Full implementation lives in webhook.Bootstrap.
		// On error we log and continue — the rest of the bridge is
		// independent of webhook delivery.
		if _, err := bootstrap.Run(ctx, []string{}); err != nil {
			log.Printf("polaris-bridge: webhook bootstrap: %v (continuing)", err)
		}
	}()

	// Baseline mirror refresh. Constructed before the webhook handler so the
	// reactive (webhook-driven) refresh path can reuse it.
	refresher := &mirrorstore.Refresher{
		Mirror:   mirrorDB,
		Client:   sdkClient,
		Interval: 30 * time.Second,
	}
	go refresher.Run(ctx)

	// Webhook receiver handler. Secret is filled in once bootstrap completes;
	// during initial boot the handler simply rejects. The refresher is wired
	// in so an inbound `message.received` event force-pulls the latest
	// mirror state BEFORE the IDLE-push fan-out fires — otherwise clients
	// race the fetch and see stale rows.
	wh := &webhook.Handler{
		Manager:   pushMgr,
		Path:      "/internal/webhook/message-received",
		Refresher: refresher,
	}

	// TLS source.
	tlsSrc, err := bridgetls.New(bridgetls.Config{
		Mode:     bridgetls.Mode(getenvDefault("BRIDGE_TLS_MODE", "local")),
		CertPath: cfg.TLSCert,
		KeyPath:  cfg.TLSKey,
	})
	if err != nil {
		log.Printf("polaris-bridge: tls init: %v (TLS-required listeners will fail)", err)
	}

	var wg sync.WaitGroup

	// SMTPS listener — inherited submission path.
	if enabled("BRIDGE_SMTPS_ENABLED", true) {
		be := &dsmtp.Backend{Deps: dsmtp.Deps{
			Store:          store,
			Forwarder:      fwd,
			Audit:          auditLog,
			MaxMessageSize: cfg.MaxMessageSize,
		}}
		smtpSrv := dsmtp.New(dsmtp.ServerOptions{
			ListenAddr:     getenvDefault("BRIDGE_SMTPS_LISTEN_ADDR", cfg.ListenAddr),
			Domain:         cfg.DaemonName,
			TLSCert:        cfg.TLSCert,
			TLSKey:         cfg.TLSKey,
			MaxMessageSize: cfg.MaxMessageSize,
		}, be)
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := smtpSrv.ListenAndServe(); err != nil {
				log.Printf("smtp server exited: %v", err)
			}
		}()
		// SIGTERM hook for SMTPS.
		go func() {
			<-ctx.Done()
			shutCtx, c := context.WithTimeout(context.Background(), 10*time.Second)
			defer c()
			_ = smtpSrv.Shutdown(shutCtx)
		}()
	}

	// IMAP listener.
	if enabled("BRIDGE_IMAP_ENABLED", true) {
		imapSrv := bridgeimap.New(bridgeimap.Options{
			ListenAddr: getenvDefault("BRIDGE_IMAP_LISTEN_ADDR", ":993"),
			TLSConfig:  tlsConfigFor(tlsSrc),
		}, bridgeimap.Deps{
			Client: sdkClient,
			Mirror: mirrorDB,
			Push:   pushMgr,
		})
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := imapSrv.Serve(ctx); err != nil {
				log.Printf("imap server exited: %v", err)
			}
		}()
	}

	// Webhook receiver — served on its own minimal HTTP listener. The
	// deployment fronts the bridge with either Tailscale (mTLS inside the
	// tailnet) or a local reverse proxy, so this listener is plain HTTP by
	// default. Operators that want TLS termination at the bridge itself
	// can put the listener behind a wrapper.
	if enabled("BRIDGE_WEBHOOK_ENABLED", true) {
		mux := http.NewServeMux()
		mux.Handle(wh.Path, wh)
		webhookSrv := &http.Server{
			Addr:              getenvDefault("BRIDGE_WEBHOOK_LISTEN_ADDR", ":8080"),
			Handler:           mux,
			ReadHeaderTimeout: 15 * time.Second,
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := webhookSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				log.Printf("webhook server exited: %v", err)
			}
		}()
		go func() {
			<-ctx.Done()
			shutCtx, c := context.WithTimeout(context.Background(), 10*time.Second)
			defer c()
			_ = webhookSrv.Shutdown(shutCtx)
		}()
	}

	// Readiness log.
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
		cancel()
	}()

	wg.Wait()
}

func openMirror(cfg *config.Config) (*mirrorstore.Mirror, error) {
	path := os.Getenv("BRIDGE_MIRROR_PATH")
	if path == "" {
		path = "/var/lib/polaris-bridge/mirror.db"
	}
	_ = cfg
	return mirrorstore.Open(path)
}

func enabled(key string, dflt bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return dflt
	}
	return v == "1" || v == "true" || v == "TRUE" || v == "yes"
}

func getenvDefault(key, dflt string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return dflt
}

func tlsConfigFor(src *bridgetls.Source) *tls.Config {
	if src == nil {
		return nil
	}
	return src.TLSConfig()
}
