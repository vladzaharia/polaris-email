// Package heartbeat owns the periodic POST /v1/bridge/heartbeat
// goroutine.
//
// Heartbeat v2 (per migration 0012): the request carries telemetry +
// node info + a log delta drained from the logbuf ring; the response
// carries enable/disable state, settings (when stale), and one-shot
// directives the bridge applies + acks on a subsequent heartbeat.
//
// Adaptive cadence: tick interval is whatever the server returned in
// `next_heartbeat_in_seconds` (60s default, can shrink to 5s during
// active operations). On error we fall back to the default and try
// again.
//
// Phase 1 behavior — what the bridge actually acts on today:
//   * `enabled: false`  → log + os.Exit(0). Compose's restart loop
//     keeps the process alive; next tick after restart sees the same
//     signal and exits again until the operator re-enables in the
//     panel. (Future: a listener supervisor that suspends without
//     exit.)
//   * `roll_hmac`       → write the new key to ./secrets/hmac_key,
//     exit, compose restart. If the directive's `new_hmac_key`
//     already matches the in-memory key (we restarted post-roll and
//     the server hasn't seen our ack yet) we just queue an ack.
//   * `restart`         → if `queued_at` is earlier than this
//     process's start time, the restart already happened; just ack.
//     Otherwise exit.
//   * `settings`        → currently logged only. Applying live
//     settings to running listeners is Phase 2.

package heartbeat

import (
	"context"
	"log"
	"os"
	"runtime"
	"sync"
	"time"

	polarissdk "github.com/polaris-mail/polaris-sdk-go"

	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/logbuf"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/metrics"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/version"
)

// MirrorRowCounter is the narrow interface the ticker needs from the
// bridge's SQLite mirror. Defining it locally rather than importing
// the concrete mirror type avoids a cycle (mirror imports SDK; we
// import SDK) and makes the package trivially mockable in tests.
type MirrorRowCounter interface {
	MessageCount() int64
}

// HMACWriter writes a new HMAC plaintext to the bridge's on-disk
// secrets file (atomically). Implementations live in the
// `cmd/polaris-bridge` package so the heartbeat doesn't reach into
// filesystem internals from a library.
type HMACWriter interface {
	WriteHMACKey(plaintext string) error
}

// Deps bundles ticker collaborators.
type Deps struct {
	Client    *polarissdk.Client
	Metrics   *metrics.Registry
	Mirror    MirrorRowCounter // optional; if nil the count is reported as 0
	LogRing   *logbuf.Ring     // optional; if nil the bridge ships no logs
	HMACKey   []byte           // current in-memory HMAC plaintext (for roll_hmac dup detection)
	WriteHMAC HMACWriter       // applies roll_hmac directive on disk
	FQDN      string           // for the acme block; empty when no ACME configured
	Interval  time.Duration    // default 60s (also the "no override" fallback)
	Settle    time.Duration    // default 5s (wait for listeners to bind)
	StartedAt time.Time        // set by Start; readers see uptime in heartbeats
}

// state carries values that change between ticks. Kept on the
// goroutine's stack rather than the Deps struct so concurrent reads
// from outside the ticker can't race the writes inside.
type state struct {
	settingsVersion int
	lastLogSeq      int64
	pendingAcks     []polarissdk.BridgeDirectiveAck
	// Directive ids we already acted on in this process lifetime.
	// Prevents re-applying the same directive within a single boot
	// (e.g. the server includes it in two heartbeats before our ack
	// lands and gets recorded server-side).
	applied map[string]bool
}

// Start launches the ticker goroutine and returns immediately. The
// goroutine exits when `ctx` is cancelled.
func Start(ctx context.Context, deps Deps) {
	if deps.Interval == 0 {
		deps.Interval = 60 * time.Second
	}
	if deps.Settle == 0 {
		deps.Settle = 5 * time.Second
	}
	if deps.StartedAt.IsZero() {
		deps.StartedAt = time.Now()
	}
	go run(ctx, deps)
}

func run(ctx context.Context, deps Deps) {
	// Brief settle so the first heartbeat fires after listeners are up.
	select {
	case <-time.After(deps.Settle):
	case <-ctx.Done():
		return
	}

	st := &state{applied: map[string]bool{}}
	interval := deps.Interval

	for {
		next := tick(ctx, deps, st)
		if next > 0 {
			interval = next
		} else {
			interval = deps.Interval
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
	}
}

// tick runs one heartbeat round trip. Returns the duration the caller
// should sleep before the next tick (from the server's
// next_heartbeat_in_seconds hint). Returns 0 on error so the caller
// falls back to its configured default.
func tick(ctx context.Context, deps Deps, st *state) time.Duration {
	req := buildRequest(deps, st)
	resp, err := deps.Client.PostBridgeHeartbeat(ctx, req)
	if err != nil {
		log.Printf("heartbeat: post failed: %v", err)
		return 0
	}

	// Server saw our acks. Clear the in-memory list — anything still
	// pending after a successful heartbeat is acknowledged from
	// here on.
	st.pendingAcks = nil

	st.lastLogSeq = resp.LogHighWater

	if resp.Settings != nil {
		log.Printf(
			"heartbeat: settings v%d received (smtp=%v imap=%v ports=%d/%d tls=%s/%s) — apply on restart",
			resp.Settings.Version,
			resp.Settings.SMTPEnabled, resp.Settings.IMAPEnabled,
			resp.Settings.SMTPPort, resp.Settings.IMAPPort,
			resp.Settings.SMTPTLSMode, resp.Settings.IMAPTLSMode,
		)
		st.settingsVersion = resp.Settings.Version
	}

	for _, d := range resp.Directives {
		applyDirective(deps, st, d)
	}

	if !resp.Enabled {
		reason := "disabled_by_admin"
		if resp.Reason != nil {
			reason = *resp.Reason
		}
		log.Printf("heartbeat: bridge disabled by admin (%s); exiting for compose to suspend", reason)
		// Defer briefly so this log line flushes before the process tears down.
		exitSoon()
	}

	if resp.NextHeartbeatInSeconds > 0 {
		return time.Duration(resp.NextHeartbeatInSeconds) * time.Second
	}
	return 0
}

func applyDirective(deps Deps, st *state, d polarissdk.BridgeDirective) {
	if st.applied[d.ID] {
		// Already handled in this process lifetime — queue the ack so
		// the server can clear it.
		st.pendingAcks = append(st.pendingAcks, polarissdk.BridgeDirectiveAck{
			ID:        d.ID,
			Kind:      d.Kind,
			AppliedAt: time.Now().UTC().Format(time.RFC3339),
		})
		return
	}
	switch d.Kind {
	case "roll_hmac":
		if d.NewHMACKey == string(deps.HMACKey) {
			// We're already running with this key (the server hasn't
			// seen our previous boot's ack yet). Just acknowledge.
			log.Printf("heartbeat: roll_hmac %s already applied; queueing ack", d.ID)
			st.applied[d.ID] = true
			st.pendingAcks = append(st.pendingAcks, polarissdk.BridgeDirectiveAck{
				ID:        d.ID,
				Kind:      d.Kind,
				AppliedAt: time.Now().UTC().Format(time.RFC3339),
			})
			return
		}
		if deps.WriteHMAC == nil {
			log.Printf("heartbeat: roll_hmac %s received but no HMACWriter wired; skipping", d.ID)
			return
		}
		if err := deps.WriteHMAC.WriteHMACKey(d.NewHMACKey); err != nil {
			log.Printf("heartbeat: roll_hmac %s: write failed: %v", d.ID, err)
			return
		}
		log.Printf("heartbeat: roll_hmac %s applied — exiting for compose restart", d.ID)
		st.applied[d.ID] = true
		exitSoon()
	case "restart":
		// If queued_at is older than this process's start, we already
		// satisfied the restart implicitly. Ack + carry on.
		if d.QueuedAt != "" {
			if qt, err := time.Parse(time.RFC3339, d.QueuedAt); err == nil && qt.Before(deps.StartedAt) {
				log.Printf("heartbeat: restart %s stale (queued before start); queueing ack", d.ID)
				st.applied[d.ID] = true
				st.pendingAcks = append(st.pendingAcks, polarissdk.BridgeDirectiveAck{
					ID:        d.ID,
					Kind:      d.Kind,
					AppliedAt: time.Now().UTC().Format(time.RFC3339),
				})
				return
			}
		}
		log.Printf("heartbeat: restart %s — exiting for compose restart", d.ID)
		st.applied[d.ID] = true
		exitSoon()
	default:
		log.Printf("heartbeat: unknown directive kind %q (id=%s); ignoring", d.Kind, d.ID)
	}
}

// exitSoon flushes stderr then exits with status 0 so docker compose's
// `restart: unless-stopped` brings the process back. Encapsulated for
// the tests to stub if we ever add unit coverage of the directive
// branches.
var exitSoon = func() {
	// Hand the runtime a sliver of time to flush stderr writes.
	time.Sleep(50 * time.Millisecond)
	os.Exit(0)
}

var (
	hostnameOnce sync.Once
	hostname     string
)

func buildRequest(deps Deps, st *state) polarissdk.BridgeHeartbeatRequest {
	hostnameOnce.Do(func() {
		h, err := os.Hostname()
		if err != nil {
			hostname = "unknown"
		} else {
			hostname = h
		}
	})

	var mirrorRows int64
	if deps.Mirror != nil {
		mirrorRows = deps.Mirror.MessageCount()
	}

	var logs []polarissdk.BridgeLogLine
	if deps.LogRing != nil {
		raw, hw := deps.LogRing.Drain(st.lastLogSeq)
		for _, l := range raw {
			logs = append(logs, polarissdk.BridgeLogLine{
				Seq:   l.Seq,
				At:    l.At.UTC().Format(time.RFC3339),
				Level: l.Level,
				Msg:   l.Msg,
			})
		}
		// Advance optimistically; the server's response carries its
		// own high-water that we adopt as authoritative after the
		// round trip.
		_ = hw
	}

	return polarissdk.BridgeHeartbeatRequest{
		SchemaVersion: 2,
		BridgeVersion: bridgeVersionString(),
		UptimeSeconds: int64(time.Since(deps.StartedAt).Round(time.Second).Seconds()),
		ReportedAt:    time.Now().UTC().Format(time.RFC3339Nano),
		Node: polarissdk.BridgeNodeInfo{
			Hostname: hostname,
			OS:       runtime.GOOS,
			Arch:     runtime.GOARCH,
		},
		Services: polarissdk.BridgeServicesBlock{
			SMTP: polarissdk.BridgeServiceState{
				Listening:      true,
				Port:           465,
				SessionsActive: 0,
				Errors24h:      deps.Metrics.Errors.Sum(),
			},
			IMAP: polarissdk.BridgeServiceState{
				Listening:      true,
				Port:           993,
				SessionsActive: deps.Metrics.IMAP.Load(),
				Errors24h:      0,
			},
			WebhookReceiver: polarissdk.BridgeWebhookReceiverState{
				Deliveries24h: deps.Metrics.Submissions.Sum(),
				Errors24h:     0,
			},
		},
		Acme: polarissdk.BridgeAcmeState{
			FQDN: deps.FQDN,
		},
		Mirror: polarissdk.BridgeMirrorState{
			MessageCount: mirrorRows,
		},
		RecentErrors:    []polarissdk.BridgeErrorRecord{},
		SettingsVersion: st.settingsVersion,
		DirectiveAcks:   st.pendingAcks,
		Logs:            logs,
		LastLogSeq:      st.lastLogSeq,
	}
}

// bridgeVersionString combines the const Version with the optional
// link-time BuildInfo so a built binary can carry a git sha or build
// date alongside the semver. Format: `<semver>` or `<semver>+<info>`.
func bridgeVersionString() string {
	if version.BuildInfo == "" {
		return version.Version
	}
	return version.Version + "+" + version.BuildInfo
}
