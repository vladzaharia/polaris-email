package mailtest

import (
	"sync"
	"time"

	polarissdk "github.com/polaris-mail/polaris-sdk-go"
)

// bridgeState is the fake's per-bridge in-memory state. All access is
// guarded by FakeServer.mu via cond; direct field access without the
// lock is a data race.
type bridgeState struct {
	id, name string

	// hmacKey is the current secret; oldHMACKey + graceExpiresAt let the
	// fake accept the prior key during a staged-rotation grace window.
	hmacKey, oldHMACKey []byte
	graceExpiresAt      time.Time

	disabled       bool
	disabledReason string

	settings polarissdk.BridgeSettings

	// pendingDirectives is the FIFO of unacked directives the bridge has
	// yet to ack. Each directive carries an ID; ack arrives in a later
	// heartbeat's directive_acks array.
	pendingDirectives []polarissdk.BridgeDirective
	// acked tracks directive IDs the bridge has ack'd so a re-enqueue
	// (test calls EnqueueDirective twice) doesn't dedupe a fresh
	// directive against an old ack.
	acked map[string]DirectiveAck

	// Observers.
	heartbeats      []Heartbeat
	heartbeatCount  int // monotonic; baseline for WaitForHeartbeat
	logHighWater    int64
	submissions     []SubmittedMessage
	patchedFlags    map[string][]string
	deletedMessages map[string]bool

	// Webhook bootstrap result — set when the bridge calls
	// POST /v1/admin/webhook-subs.
	webhookSecret []byte
	webhookURL    string

	// nextHeartbeatSeconds influences the bridge's adaptive cadence:
	// when >0 the heartbeat response carries this value; the bridge
	// uses it as the interval before the next tick.
	nextHeartbeatSeconds int

	// heartbeatFailures injects a transient failure for the next N
	// heartbeats — the fake responds with 500 so the bridge's
	// ticker has to retry. Used by H4 (fallback cadence).
	heartbeatFailures int

	// Mailboxes the bridge serves. The fake doesn't enforce
	// bridge↔mailbox ownership (real production does); tests register
	// what they need.
	mailboxIDs map[string]struct{}

	// autoRoute, when enabled, makes POST /v1/messages parse the
	// recipient(s) from the RFC822 body, add the message to each
	// matching mailbox's message list, and fire a `message.received`
	// webhook to the bridge. Used by E2E tests that want a single
	// "send via SMTP → see via IMAP" roundtrip without manual fake
	// scripting.
	autoRoute bool
}

// mailboxState is global to the fake (not per-bridge) because in
// production mailboxes are bridge-agnostic — a bridge serves whatever
// the control plane tells it to. The fake mirrors that.
type mailboxState struct {
	id        string
	ownerAddr string

	// changeID advances on every state mutation that should reach the
	// bridge via /changes (seed, flag patch, delete).
	changeID int64
	uidValid int64

	// messageOrder is the deterministic order messages were added (so
	// "added" / "updated" / "deleted" slices in /changes match the
	// production semantics).
	messageOrder []string
	deleted      map[string]bool

	// For UID assignment.
	nextUID int64
}

// messageState carries metadata + body. body is the raw RFC822 the
// bridge submitted (or seeded by the test).
type messageState struct {
	id        string
	mailboxID string
	uid       int64
	flags     []string
	subject   string
	fromAddr  string
	headerID  string
	bodyBytes int64
	body      []byte
	createdAt string
}

// credKey produces the lookup key for a (protocol, username) lookup.
func credKey(protocol, username string) string {
	return protocol + ":" + username
}

type credentialState struct {
	id         string
	mailboxID  string
	protocol   string
	username   string
	bcryptHash string
}

// fakeState is the top-level state container. One per FakeServer.
type fakeState struct {
	mu   sync.Mutex
	cond *sync.Cond

	bridges        map[string]*bridgeState
	mailboxes      map[string]*mailboxState
	mailboxByOwner map[string]string // owner → mailbox id
	messages       map[string]*messageState
	credentials    map[string]*credentialState // key: credKey(protocol, username)

	// idCounter for synthesizing bridge/mailbox/message/directive IDs.
	idCounter int64
}

func newFakeState() *fakeState {
	s := &fakeState{
		bridges:        map[string]*bridgeState{},
		mailboxes:      map[string]*mailboxState{},
		mailboxByOwner: map[string]string{},
		messages:       map[string]*messageState{},
		credentials:    map[string]*credentialState{},
	}
	s.cond = sync.NewCond(&s.mu)
	return s
}

// nextID returns a short id "n<counter>" used for bridges/mailboxes/messages.
func (s *fakeState) nextID(prefix string) string {
	s.idCounter++
	return prefix + "-" + formatBase36(s.idCounter)
}

// defaultSettings returns the v0 settings every newly-registered bridge
// starts with. Version is 0 so the first heartbeat (bridge sends
// settings_version=0) doesn't trigger a settings response → no Apply →
// no restart loop. Tests that want settings changes call
// UpdateSettings which bumps the version.
//
// Ports default to the production values but the harness should
// SyncBridgePorts before the bridge boots so any subsequent
// UpdateSettings patch preserves the test-bound ports rather than
// reverting to 465/25/993/143 and triggering a restart-required Apply.
func defaultSettings() polarissdk.BridgeSettings {
	return polarissdk.BridgeSettings{
		Version:      0,
		SMTPSEnabled: true,
		SMTPSPort:    465,
		SMTPEnabled:  false,
		SMTPPort:     25,
		IMAPSEnabled: true,
		IMAPSPort:    993,
		IMAPEnabled:  false,
		IMAPPort:     143,
		TLSSource:    "auto",
		// Mirror the real server default (migration 0013 = 50 MiB) and the
		// bridge's boot default. A mismatch here is a restart-required diff
		// on every first heartbeat, which loops the bridge and starves
		// these multi-heartbeat tests (got 1 heartbeat, want ≥3).
		MaxMessageSizeBytes: 50 * 1024 * 1024,
		MaxIMAPSessions:     200,
		LogLevel:            "info",
		// Mirror the inproc harness's BRIDGE_WEBHOOK_ENABLED=1 default so
		// the first server-side heartbeat reply doesn't immediately
		// disable the receiver under existing webhook tests.
		WebhookEnabled: true,
	}
}

// applyPatch returns a copy of s with patch overlaid. Bumping the
// Version is the caller's responsibility.
func applyPatch(s polarissdk.BridgeSettings, p SettingsPatch) polarissdk.BridgeSettings {
	out := s
	if p.SMTPSEnabled != nil {
		out.SMTPSEnabled = *p.SMTPSEnabled
	}
	if p.SMTPSPort != nil {
		out.SMTPSPort = *p.SMTPSPort
	}
	if p.SMTPEnabled != nil {
		out.SMTPEnabled = *p.SMTPEnabled
	}
	if p.SMTPPort != nil {
		out.SMTPPort = *p.SMTPPort
	}
	if p.IMAPSEnabled != nil {
		out.IMAPSEnabled = *p.IMAPSEnabled
	}
	if p.IMAPSPort != nil {
		out.IMAPSPort = *p.IMAPSPort
	}
	if p.IMAPEnabled != nil {
		out.IMAPEnabled = *p.IMAPEnabled
	}
	if p.IMAPPort != nil {
		out.IMAPPort = *p.IMAPPort
	}
	if p.TLSSource != nil {
		out.TLSSource = *p.TLSSource
	}
	if p.MaxMessageSizeBytes != nil {
		out.MaxMessageSizeBytes = *p.MaxMessageSizeBytes
	}
	if p.MaxIMAPSessions != nil {
		out.MaxIMAPSessions = *p.MaxIMAPSessions
	}
	if p.LogLevel != nil {
		out.LogLevel = *p.LogLevel
	}
	if p.WebhookEnabled != nil {
		out.WebhookEnabled = *p.WebhookEnabled
	}
	if p.WebhookURLOverride != nil {
		out.WebhookURLOverride = *p.WebhookURLOverride
	}
	return out
}

// formatBase36 — tiny inline so we don't pull strconv just for this.
const base36Alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"

func formatBase36(n int64) string {
	if n == 0 {
		return "0"
	}
	var buf [16]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = base36Alphabet[n%36]
		n /= 36
	}
	return string(buf[i:])
}
