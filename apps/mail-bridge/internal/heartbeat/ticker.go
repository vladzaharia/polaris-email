// Package heartbeat owns the periodic POST /v1/bridge/heartbeat goroutine.
//
// One ticker per bridge process. The first heartbeat fires after a short
// settle delay (so listeners have a chance to bind before we tell the
// control plane we exist); then every `Interval` thereafter. The
// goroutine exits on context cancel; heartbeat post errors are logged
// and never propagated — losing a single heartbeat is fine, the next
// tick will paper over it.
//
// The package depends only on `polaris-sdk-go` (already in go.mod) and
// the bridge-local metrics + version packages.
package heartbeat

import (
	"context"
	"log"
	"time"

	polarissdk "github.com/polaris-mail/polaris-sdk-go"

	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/metrics"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/version"
)

// MirrorRowCounter is the narrow interface the ticker needs from the
// bridge's SQLite mirror. Defining it locally rather than importing the
// concrete mirror type avoids a cycle (mirror imports SDK; we import
// SDK) and makes the package trivially mockable in tests.
type MirrorRowCounter interface {
	MessageCount() int64
}

// Deps bundles ticker collaborators.
type Deps struct {
	Client   *polarissdk.Client
	Metrics  *metrics.Registry
	Mirror   MirrorRowCounter // optional; if nil the count is reported as 0
	Interval time.Duration    // default 60s
	Settle   time.Duration    // default 5s (wait for listeners to bind)
	StartedAt time.Time       // set by Start; readers see uptime in heartbeats
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
	// We still respect ctx cancellation during the settle to keep
	// shutdown snappy.
	select {
	case <-time.After(deps.Settle):
	case <-ctx.Done():
		return
	}

	post := func() {
		hb := buildPayload(deps)
		if err := deps.Client.PostBridgeHeartbeat(ctx, hb); err != nil {
			// Best-effort transport; just log and move on. The control
			// plane will infer staleness from a missing heartbeat.
			log.Printf("heartbeat: post failed: %v (continuing)", err)
			return
		}
	}
	post() // first beat

	t := time.NewTicker(deps.Interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			post()
		}
	}
}

func buildPayload(deps Deps) polarissdk.BridgeHeartbeat {
	var mirrorRows int64
	if deps.Mirror != nil {
		mirrorRows = deps.Mirror.MessageCount()
	}
	return polarissdk.BridgeHeartbeat{
		SchemaVersion:      1,
		BridgeVersion:      bridgeVersionString(),
		UptimeSeconds:      int64(time.Since(deps.StartedAt).Round(time.Second).Seconds()),
		IMAPSessionsActive: deps.Metrics.IMAP.Load(),
		SMTPSubmissions24h: deps.Metrics.Submissions.Sum(),
		Errors24h:          deps.Metrics.Errors.Sum(),
		MirrorMessageCount: int(mirrorRows),
		ReportedAt:         time.Now().UTC().Format(time.RFC3339Nano),
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
