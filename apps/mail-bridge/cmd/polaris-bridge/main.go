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
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapserver"
	polarissdk "github.com/polaris-mail/polaris-sdk-go"

	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/acme"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/audit"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/config"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/credstore"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/forwarder"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/heartbeat"
	bridgeimap "github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/imap"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/metrics"
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
	log.Printf("polaris-bridge starting: name=%s id=%s", cfg.BridgeName, cfg.BridgeID)

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

	// Single bridge-wide context. Downstream goroutines (poller,
	// refresher, heartbeat, renewer) all derive from this; SIGTERM at
	// the bottom of main cancels and propagates.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	poller := credstore.NewPoller(credstore.PollerConfig{
		APIURL:   cfg.APIURL,
		HMACKey:  cfg.HMACKey,
		BridgeID: cfg.BridgeID,
		Interval: cfg.PollInterval,
	}, store)

	fwd := forwarder.New(forwarder.Config{
		APIURL:     cfg.APIURL,
		HMACKey:    cfg.HMACKey,
		BridgeID:   cfg.BridgeID,
		HTTPClient: httpClient,
	})

	// Polaris SDK client used by the IMAP listener + push.
	// CF Access is not in front of the polaris API; the bridge HMAC is
	// the only auth surface (see project memory).
	sdkClient := polarissdk.NewClient(cfg.APIURL)
	sdkClient.BridgeID = cfg.BridgeID
	sdkClient.BridgeSecret = cfg.HMACKey

	// ---------- Fetch operational config + start embedded ACME ----------
	//
	// `/v1/bridge/config` returns the per-bridge CF DNS-01 token, the
	// bridge's canonical FQDN (`<name>.mail.plrs.im`), and the ACME
	// contact email. We MUST have a valid cert on disk before TLS
	// listeners come up — falling back to plaintext would expose SMTP
	// AUTH / IMAP LOGIN. Failure here is fatal.
	//
	// Retry the fetch once if it returns `key_propagating` — that's the
	// expected transient when the operator rotated the bridge between
	// process restart and our first call.
	configCtx, configCancel := context.WithTimeout(ctx, 60*time.Second)
	bridgeCfg, err := sdkClient.GetBridgeConfig(configCtx)
	configCancel()
	if err != nil {
		log.Fatalf("polaris-bridge: fetch bridge config: %v", err)
	}
	log.Printf("polaris-bridge: bridge config fetched (fqdn=%s)", bridgeCfg.FQDN)

	renewer := &acme.Renewer{
		FQDN:       bridgeCfg.FQDN,
		AcmeEmail:  bridgeCfg.AcmeEmail,
		CFDnsToken: bridgeCfg.CFDnsToken,
		// Lego resolves the zone id from the FQDN via its own
		// `/zones?name=...` lookup (the per-bridge token has Zone:Read
		// scope for that). For our own A-record upsert we need the
		// zone id explicitly — get it from the same Lego provider on
		// first cert issue. To keep startup linear, leave CFZoneID
		// empty here; the renewer skips A-record management when
		// empty. Setting it requires the operator to wire the zone id
		// into the api worker's response (already in scope; the api
		// returns cf_zone but not the zone id). Followup: add zone_id
		// to BridgeConfigResponse so this path activates.
		CFZoneID: "",
		CertDir:  cfg.TLSCertDir,
		BridgeIP: acme.DetectBridgeIP(),
	}
	if err := renewer.EnsureCert(ctx); err != nil {
		log.Fatalf("polaris-bridge: initial acme: %v", err)
	}
	renewer.Start(ctx)

	// Bridge-local SQLite mirror.
	mirrorDB, err := openMirror(cfg)
	if err != nil {
		log.Fatalf("mirror open: %v", err)
	}
	defer mirrorDB.Close()

	pushMgr := push.New()

	// In-process counters fed into the heartbeat ticker. IMAP/SMTP
	// backends bump them inline; the ticker just reads.
	metricsReg := metrics.New()

	// Webhook subscription bootstrap. Auto-registers a sub on polaris that
	// posts to this bridge's /internal/webhook/message-received path.
	//
	// Phase 4b.4: when the webhook receiver is enabled, BRIDGE_PUBLIC_URL
	// MUST be a routable URL polaris can reach. The previous default of
	// "https://localhost" silently registered an unreachable subscription
	// polaris would queue every event into a delivery loop that never
	// succeeded. Fail fast at startup so the operator notices immediately.
	publicURL := os.Getenv("BRIDGE_PUBLIC_URL")
	if enabled("BRIDGE_WEBHOOK_ENABLED", true) {
		if err := validatePublicWebhookURL(publicURL); err != nil {
			log.Fatalf("polaris-bridge: BRIDGE_PUBLIC_URL invalid: %v", err)
		}
	}
	if publicURL == "" {
		// Webhook disabled; placeholder keeps Bootstrap.Run from blowing up
		// on URL parse, though the goroutine that runs it is gated below.
		publicURL = "https://localhost"
	}
	bootstrap := &webhook.Bootstrap{
		Client:    sdkClient,
		PublicURL: publicURL,
		Path:      "/internal/webhook/message-received",
	}

	go poller.Run(ctx)

	// Baseline mirror refresh. Constructed before the webhook handler so the
	// reactive (webhook-driven) refresh path can reuse it.
	refresher := &mirrorstore.Refresher{
		Mirror:   mirrorDB,
		Client:   sdkClient,
		Interval: 30 * time.Second,
	}
	go refresher.Run(ctx)

	// Webhook receiver handler. Secret is empty until bootstrap completes;
	// the handler rejects with 503 in that window (see ServeHTTP). The
	// refresher is wired in so an inbound `message.received` event
	// force-pulls the latest mirror state BEFORE the IDLE-push fan-out
	// fires — otherwise clients race the fetch and see stale rows.
	wh := &webhook.Handler{
		Manager:   pushMgr,
		Path:      "/internal/webhook/message-received",
		Refresher: refresher,
	}

	// Bootstrap webhook subs in the background. Once the bootstrap returns
	// the per-subscription secret we thread it onto the handler so HMAC
	// verification flips from fail-closed (no secret → 503) to actually
	// authenticating signatures. Pre-2d this assignment was missing,
	// leaving the handler running with `Secret == nil` which made
	// VerifyWebhook a no-op against an empty key — every replay would have
	// been admitted.
	go func() {
		// Pragmatic stub: enumerate mailboxes from polaris and register
		// subs for each. Full implementation lives in webhook.Bootstrap.
		// On error we log and continue — the rest of the bridge is
		// independent of webhook delivery.
		results, err := bootstrap.Run(ctx, []string{})
		if err != nil {
			log.Printf("polaris-bridge: webhook bootstrap: %v (continuing)", err)
			return
		}
		if secret := webhook.FirstSecret(results); secret != nil {
			wh.SetSecret(secret)
			log.Printf("polaris-bridge: webhook secret installed (%d subs)", len(results))
		} else if len(results) > 0 {
			// Reused subs only — operator has to re-issue if the secret was
			// lost. Surface clearly so the operator notices.
			log.Printf("polaris-bridge: webhook bootstrap reused %d existing sub(s) — secret unknown locally; webhook handler will reject until secret is rotated", len(results))
		}
	}()

	// TLS source — points at the cert dir the embedded ACME renewer
	// just populated. Source.GetCertificate does its own 30s reload
	// cadence, so future renewals just write fresh PEMs and SMTPS /
	// IMAP pick them up on the next accept. Falling back to plaintext
	// would expose SMTP AUTH / IMAP LOGIN; this stays fail-fast.
	tlsSrc, err := bridgetls.New(bridgetls.Config{
		Mode:     bridgetls.ModeLocal,
		CertPath: cfg.TLSCertPath(),
		KeyPath:  cfg.TLSKeyPath(),
	})
	if err != nil {
		log.Fatalf("polaris-bridge: tls init: %v (refusing to start with insecure listeners)", err)
	}

	var wg sync.WaitGroup

	// SMTPS listener — inherited submission path. We block startup briefly
	// on the credstore poller so we don't accept connections that would
	// just 454 every AUTH; if the initial sync never completes we still
	// proceed but log a clear warning so operators see it (acceptable
	// because it lets the bridge come up while the API is briefly down,
	// and the next successful poll will heal auth).
	if enabled("BRIDGE_SMTPS_ENABLED", true) {
		waitForCredstore(ctx, poller, 30*time.Second)
		authLockout := credstore.NewLockout()
		be := &dsmtp.Backend{
			Deps: dsmtp.Deps{
				Store:          store,
				Forwarder:      fwd,
				Audit:          auditLog,
				MaxMessageSize: cfg.MaxMessageSize,
				Lockout:        authLockout,
				Metrics: &dsmtp.MetricsHooks{
					Submissions: metricsReg.Submissions,
					Errors:      metricsReg.Errors,
				},
			},
			RootContext: ctx,
		}
		smtpSrv := dsmtp.New(dsmtp.ServerOptions{
			ListenAddr:     getenvDefault("BRIDGE_SMTPS_LISTEN_ADDR", cfg.ListenAddr),
			Domain:         cfg.BridgeName,
			TLSCert:        cfg.TLSCertPath(),
			TLSKey:         cfg.TLSKeyPath(),
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

	// IMAP listener — emersion/go-imap v2 imapserver wrapping our backend.
	// IMAP4rev2 is advertised when supported; the library handles all wire
	// concerns + capability honesty. INBOX-only is enforced inside the
	// backend's Session methods.
	if enabled("BRIDGE_IMAP_ENABLED", true) {
		imapBackend := &bridgeimap.Backend{
			Client:       sdkClient,
			Mirror:       mirrorDB,
			Push:         pushMgr,
			SessionGauge: metricsReg.IMAP,
			MaxBodyBytes:  cfg.R2BodyMaxBytes,
		}
		imapTLSCfg := tlsConfigFor(tlsSrc)
		if imapTLSCfg == nil {
			// We fail-fast on tlsSrc=nil above, so this branch should be
			// unreachable; kept for defense-in-depth so a future refactor
			// can't accidentally re-introduce the InsecureAuth fallback.
			log.Fatalf("polaris-bridge: imap: TLS config nil after init succeeded — refusing to serve plaintext")
		}
		imapSrv := imapserver.New(&imapserver.Options{
			NewSession: imapBackend.NewSession,
			Caps: imap.CapSet{
				imap.CapIMAP4rev2:     {},
				imap.CapIMAP4rev1:     {},
				imap.AuthCap("PLAIN"): {},
			},
			TLSConfig:    imapTLSCfg,
			InsecureAuth: false,
		})
		imapAddr := getenvDefault("BRIDGE_IMAP_LISTEN_ADDR", ":993")
		imapLn, err := tls.Listen("tcp", imapAddr, imapTLSCfg)
		if err != nil {
			log.Fatalf("imap listen: %v", err)
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := imapSrv.Serve(imapLn); err != nil {
				log.Printf("imap server exited: %v", err)
			}
		}()
		go func() {
			<-ctx.Done()
			// Close the listener explicitly so the underlying TCP socket
			// + file descriptor is released; imapSrv.Close() alone is not
			// guaranteed to release it on every emersion/go-imap version.
			_ = imapLn.Close()
			_ = imapSrv.Close()
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

	// Heartbeat ticker — POST /v1/bridge/heartbeat every 60s with version
	// + counter snapshot. Best-effort; failures log and we move on. The
	// ticker also implicitly bumps `bridges.last_seen_at` on the API side
	// since the heartbeat goes through bridgeHmacAuth.
	heartbeat.Start(ctx, heartbeat.Deps{
		Client:    sdkClient,
		Metrics:   metricsReg,
		Mirror:    mirrorDB,
		StartedAt: time.Now(),
	})

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

// validatePublicWebhookURL rejects empty, localhost, and loopback values
// so the webhook bootstrap can't silently register an unreachable URL with
// polaris. The check is intentionally conservative: any host substring
// match against "localhost" / "127.0.0.1" / "::1" trips it. Operators
// running an explicit reverse proxy in front of the bridge should set
// BRIDGE_PUBLIC_URL to that proxy's externally-routable URL.
func validatePublicWebhookURL(raw string) error {
	if raw == "" {
		return errors.New("BRIDGE_PUBLIC_URL must be set when BRIDGE_WEBHOOK_ENABLED is true; polaris must be able to reach this bridge to deliver events")
	}
	lower := strings.ToLower(raw)
	for _, banned := range []string{"localhost", "127.0.0.1", "[::1]", "://::1"} {
		if strings.Contains(lower, banned) {
			return errors.New("BRIDGE_PUBLIC_URL " + raw + " resolves to a loopback host; polaris cannot reach it. Set BRIDGE_PUBLIC_URL to your bridge's externally-routable URL (or set BRIDGE_WEBHOOK_ENABLED=false to disable the receiver entirely)")
		}
	}
	return nil
}

// waitForCredstore blocks up to `timeout` for the poller's first successful
// sync. On timeout it logs a clear WARN and returns; SMTPS will start but
// every AUTH will 454 until the next sync succeeds. Operators see the
// warning in `docker logs` and can investigate.
func waitForCredstore(ctx context.Context, p *credstore.Poller, timeout time.Duration) {
	if p.Ready() {
		return
	}
	deadline := time.Now().Add(timeout)
	t := time.NewTicker(200 * time.Millisecond)
	defer t.Stop()
	for {
		if p.Ready() {
			log.Printf("polaris-bridge: credstore initial sync complete")
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if time.Now().After(deadline) {
				log.Printf("WARN: polaris-bridge: credstore initial sync did not complete within %s — SMTPS listener will start but ALL AUTH will fail with 454 until the next successful poll", timeout)
				return
			}
		}
	}
}
