package mailtest

import (
	"context"
	"crypto/tls"
	"io"
	"os"
	"testing"
	"time"
)

// HarnessOpts is the per-test configuration accepted by HarnessFactory.
// All fields are optional; zero values pick safe defaults.
type HarnessOpts struct {
	// BridgeSettings is the initial settings the supervisor starts with.
	// The first heartbeat will overwrite from the server.
	BridgeSettings *BridgeSettingsOverride

	// InitialMailboxes / InitialCreds / InitialMessages are seeded into
	// the fake before the bridge boots. Useful for IMAP read tests that
	// need a populated mirror at first SELECT.
	InitialMailboxes []SeedMailbox
	InitialCreds     []SeedCredential
	InitialMessages  []SeedMessage

	// WithoutTLS skips cert minting and writes nothing to the bridge's
	// cert dir, exercising the plaintext-fallback path.
	WithoutTLS bool

	// HeartbeatInterval / HeartbeatSettle override the bridge's
	// BRIDGE_HEARTBEAT_INTERVAL / BRIDGE_HEARTBEAT_SETTLE env knobs.
	// Defaults: 250ms interval, 250ms settle (chosen to keep test
	// wall-clock tight without slamming the fake).
	HeartbeatInterval time.Duration
	HeartbeatSettle   time.Duration

	// TLSReloadInterval overrides BRIDGE_TLS_RELOAD_INTERVAL. Defaults
	// to 1s in tests so cert hot-reload assertions don't bust the
	// CI timeout.
	TLSReloadInterval time.Duration

	// AuthLockoutCooldown overrides BRIDGE_AUTH_LOCKOUT_COOLDOWN.
	// Defaults to 2s in tests so the SEC2 cooldown-expires assertion
	// runs in reasonable time.
	AuthLockoutCooldown time.Duration

	// ExtraEnv supplies additional env vars to the bridge process.
	// Used for ad-hoc per-test config (e.g. disabling SMTPS listener
	// for an IMAP-only test).
	ExtraEnv map[string]string
}

// Harness is the test-facing surface. One Harness == one bridge + one
// control plane (fake or real).
type Harness interface {
	// Lifecycle.
	Start(ctx context.Context) error
	Stop(ctx context.Context) error

	// Bridge identity — the row the harness registered with the control
	// plane on behalf of this test.
	Bridge() Bridge

	// Network — addresses the bridge listens on. host:port; "" when the
	// corresponding listener isn't enabled.
	SMTPSAddr() string
	SMTPAddr() string
	IMAPSAddr() string
	IMAPAddr() string
	WebhookAddr() string

	// APIBaseURL is the URL the bridge points at for control-plane calls
	// (the fake httptest server, or wrangler dev for tier 3).
	APIBaseURL() string

	// CABundle returns a tls.Config preloaded with the harness CA, so
	// test SMTPS / IMAPS clients trust the bridge's self-signed cert.
	// Nil when WithoutTLS=true.
	CABundle() *tls.Config

	// ReplaceCert rewrites the bridge's on-disk cert PEMs. Used by the
	// TLS hot-reload test (T3) to observe the bridge serving a new cert.
	ReplaceCert(t *testing.T, cert tls.Certificate)

	// Fake returns the in-process control plane handle, or nil for
	// suites that talk to a real control plane (mailtest_contract).
	Fake() FakeControlPlane

	// BridgeLogs is a reader over the bridge's stderr (a buffered tail).
	BridgeLogs() io.Reader

	// SendSignal sends a signal to the bridge process. SIGTERM is what
	// the user invokes for graceful shutdown.
	SendSignal(sig os.Signal) error

	// RestartBridge kills and respawns the bridge under the same env.
	// Used by HMAC-rotation tests that need to observe the bridge come
	// back up with a new key file.
	RestartBridge(ctx context.Context) error

	// WaitForRestart blocks until the harness observes a clean exit and
	// respawn (the in-proc harness supervises the subprocess and brings
	// it back up under the same env, mirroring docker compose's
	// `restart: unless-stopped`).
	WaitForRestart(ctx context.Context) error

	// ReadHMACKeyFile returns the current bytes of the bridge's HMAC
	// key file on disk. Used by R2 to confirm a roll persisted.
	ReadHMACKeyFile() []byte
}

// HarnessFactory constructs a Harness for one test. Suite-specific
// packages (mailtest_inproc, mailtest_docker, mailtest_contract)
// implement this.
type HarnessFactory func(t *testing.T, opts HarnessOpts) Harness

// FakeControlPlane is the in-process Go fake's setup + assertion API.
// Suites that talk to a real control plane return nil from Harness.Fake();
// scenarios that need fake-only features (e.g. WaitForHeartbeat with
// monotonic cond semantics) must guard with `if h.Fake() == nil { t.Skip(...) }`.
type FakeControlPlane interface {
	// Bridges returns the registered bridges (the harness pre-registers
	// one on Start; some tests register additional bridges).
	Bridges() []Bridge

	// RegisterBridge mints a new bridge id + HMAC key. Returns the
	// Bridge so the test can write the key to the bridge's config.
	RegisterBridge(name string) Bridge

	// SeedMailbox / CreateCredential / SeedMessage populate the fake's
	// in-memory state. Mailbox is keyed by OwnerAddr (one mailbox per
	// owner email).
	SeedMailbox(owner string) Mailbox
	CreateCredential(mb Mailbox, user, pass, proto string) Credential
	SeedMessage(mb Mailbox, msg SeedMessage) MessageID

	// Admin pokes — change state the bridge will observe on its next
	// heartbeat.
	DisableBridge(b Bridge)
	EnableBridge(b Bridge)
	UpdateSettings(b Bridge, patch SettingsPatch)
	EnqueueDirective(b Bridge, d Directive) DirectiveID
	// StageHMACRotation generates a new HMAC, enqueues a roll_hmac
	// directive, and keeps the old key valid for the grace window.
	// Returns the new key plaintext for the test to verify.
	StageHMACRotation(b Bridge, grace time.Duration) (newKey string)

	// Control plane → bridge — POST the signed webhook payload to the
	// bridge's :8080 receiver.
	DeliverWebhook(ctx context.Context, b Bridge, payload WebhookPayload) error

	// Webhook secret + URL the bridge bootstrapped (after bridge calls
	// POST /v1/admin/webhook-subs). Set when bootstrap completes.
	WebhookSecret(b Bridge) []byte
	WebhookURL(b Bridge) string

	// Observers — block until a thing the bridge does is observed.
	WaitForHeartbeat(ctx context.Context, b Bridge) Heartbeat
	WaitForNHeartbeats(ctx context.Context, b Bridge, n int) []Heartbeat
	WaitForDirectiveAck(ctx context.Context, b Bridge, id DirectiveID) DirectiveAck
	WaitForSubmittedMessage(ctx context.Context, b Bridge) SubmittedMessage
	LastHeartbeat(b Bridge) (Heartbeat, bool)
	LogHighWater(b Bridge) int64
	SubmissionsFor(b Bridge) []SubmittedMessage

	// Patches and deletes observed for IMAP STORE/EXPUNGE assertions.
	PatchedFlags(b Bridge, messageID string) ([]string, bool)
	DeletedMessage(b Bridge, messageID string) bool
}

