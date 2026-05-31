package mailtest

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	polarissdk "github.com/polaris-mail/polaris-sdk-go"
)

// FakeServer is an in-process httptest server that implements every
// bridge-facing control-plane endpoint. It satisfies FakeControlPlane.
type FakeServer struct {
	server *httptest.Server
	state  *fakeState

	// HTTP client used by DeliverWebhook to POST to the bridge's :8080.
	httpClient *http.Client
}

// NewFakeServer constructs and starts a FakeServer. Caller must Close().
func NewFakeServer() *FakeServer {
	f := &FakeServer{
		state:      newFakeState(),
		httpClient: &http.Client{Timeout: 5 * time.Second},
	}
	f.server = httptest.NewServer(newFakeMux(f))
	return f
}

// URL is the base URL the bridge points at via BRIDGE_POLARIS_API_URL.
func (f *FakeServer) URL() string { return f.server.URL }

// Close shuts down the server. The receiver is safe for nil-check.
func (f *FakeServer) Close() {
	if f == nil || f.server == nil {
		return
	}
	f.server.Close()
}

// -------- FakeControlPlane impl --------

// Bridges returns a snapshot.
func (f *FakeServer) Bridges() []Bridge {
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	out := make([]Bridge, 0, len(f.state.bridges))
	for _, b := range f.state.bridges {
		out = append(out, Bridge{ID: b.id, Name: b.name, HMACKey: copyBytes(b.hmacKey)})
	}
	return out
}

func (f *FakeServer) RegisterBridge(name string) Bridge {
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	id := f.state.nextID("br")
	key := randomKey()
	f.state.bridges[id] = &bridgeState{
		id:              id,
		name:            name,
		hmacKey:         key,
		settings:        defaultSettings(),
		acked:           map[string]DirectiveAck{},
		patchedFlags:    map[string][]string{},
		deletedMessages: map[string]bool{},
		mailboxIDs:      map[string]struct{}{},
	}
	return Bridge{ID: id, Name: name, HMACKey: copyBytes(key)}
}

func (f *FakeServer) SeedMailbox(owner string) Mailbox {
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	if id, ok := f.state.mailboxByOwner[owner]; ok {
		return Mailbox{ID: id, OwnerAddr: owner}
	}
	id := f.state.nextID("mb")
	f.state.mailboxes[id] = &mailboxState{
		id:        id,
		ownerAddr: owner,
		changeID:  0,
		uidValid:  1,
		nextUID:   1,
		deleted:   map[string]bool{},
	}
	f.state.mailboxByOwner[owner] = id
	// Auto-attach to every registered bridge.
	for _, b := range f.state.bridges {
		b.mailboxIDs[id] = struct{}{}
	}
	return Mailbox{ID: id, OwnerAddr: owner}
}

func (f *FakeServer) CreateCredential(mb Mailbox, user, pass, proto string) Credential {
	// Bcrypt at cost 4 (matching internal/imap/imap_test.go: 4 is fast
	// enough for tests; production uses cost 12).
	hash, err := bcryptHash(pass, 4)
	if err != nil {
		panic(fmt.Sprintf("mailtest: bcrypt: %v", err))
	}
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	id := f.state.nextID("cred")
	c := &credentialState{
		id: id, mailboxID: mb.ID, protocol: proto, username: user, bcryptHash: hash,
	}
	f.state.credentials[credKey(proto, user)] = c
	return Credential{
		ID: id, MailboxID: mb.ID, Protocol: proto, Username: user, BcryptHash: hash,
	}
}

func (f *FakeServer) SeedMessage(mb Mailbox, msg SeedMessage) MessageID {
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	mbox, ok := f.state.mailboxes[mb.ID]
	if !ok {
		panic("mailtest: SeedMessage: mailbox not found")
	}
	id := f.state.nextID("msg")
	uid := mbox.nextUID
	mbox.nextUID++
	flags := append([]string{}, msg.Flags...)
	headerID := msg.HeaderMessageID
	if headerID == "" {
		headerID = fmt.Sprintf("<%s@mailtest>", id)
	}
	f.state.messages[id] = &messageState{
		id: id, mailboxID: mb.ID, uid: uid,
		flags: flags, subject: msg.Subject, fromAddr: msg.From,
		headerID: headerID, bodyBytes: msg.BodyBytes,
		createdAt: time.Now().UTC().Format(time.RFC3339),
	}
	mbox.messageOrder = append(mbox.messageOrder, id)
	mbox.changeID++
	return MessageID(id)
}

func (f *FakeServer) DisableBridge(b Bridge) {
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	if br, ok := f.state.bridges[b.ID]; ok {
		br.disabled = true
		br.disabledReason = "disabled_by_admin"
	}
}

func (f *FakeServer) EnableBridge(b Bridge) {
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	if br, ok := f.state.bridges[b.ID]; ok {
		br.disabled = false
		br.disabledReason = ""
	}
}

func (f *FakeServer) UpdateSettings(b Bridge, patch SettingsPatch) {
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	br, ok := f.state.bridges[b.ID]
	if !ok {
		return
	}
	br.settings = applyPatch(br.settings, patch)
	br.settings.Version++
}

// EnableAutoRoute turns on "inbound auto-route" mode for the bridge:
// when the bridge POSTs /v1/messages, the fake parses the To header,
// creates a message in each matching mailbox, and fires a
// `message.received` webhook back to the bridge. Lets E2E tests
// validate the full SMTP → webhook → IMAP roundtrip with one
// orchestrating call rather than manually scripting webhook delivery.
func (f *FakeServer) EnableAutoRoute(b Bridge) {
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	if br, ok := f.state.bridges[b.ID]; ok {
		br.autoRoute = true
	}
}

// SyncBridgePorts overwrites the stored bridge settings' ports without
// bumping the version. Used by the harness immediately after
// RegisterBridge so any later UpdateSettings preserves the test-bound
// ports rather than reverting to production defaults (which would
// trigger restart-required Apply on the bridge).
func (f *FakeServer) SyncBridgePorts(b Bridge, smtpsPort, smtpPort, imapsPort, imapPort int) {
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	br, ok := f.state.bridges[b.ID]
	if !ok {
		return
	}
	br.settings.SMTPSPort = smtpsPort
	br.settings.SMTPPort = smtpPort
	br.settings.IMAPSPort = imapsPort
	br.settings.IMAPPort = imapPort
}

// SyncBridgeWebhookURL seeds the per-bridge settings' webhook URL
// override to match whatever the inproc/docker harness passed to the
// bridge via BRIDGE_PUBLIC_URL. Without this, the first heartbeat
// response would diff against the bridge's initial-settings override
// and trigger a restart-required Apply on every boot.
func (f *FakeServer) SyncBridgeWebhookURL(b Bridge, url string) {
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	if br, ok := f.state.bridges[b.ID]; ok {
		br.settings.WebhookURLOverride = url
	}
}

// SetNextHeartbeatSeconds influences the bridge's adaptive cadence —
// future heartbeat responses carry this value in NextHeartbeatInSeconds.
// Used by H3.
func (f *FakeServer) SetNextHeartbeatSeconds(b Bridge, n int) {
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	if br, ok := f.state.bridges[b.ID]; ok {
		br.nextHeartbeatSeconds = n
	}
}

// InjectHeartbeatFailures schedules the next n heartbeat POSTs to
// respond with HTTP 500 (after which normal behavior resumes). Used by
// H4 (fallback-cadence-on-error).
func (f *FakeServer) InjectHeartbeatFailures(b Bridge, n int) {
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	if br, ok := f.state.bridges[b.ID]; ok {
		br.heartbeatFailures = n
	}
}

// SignWithOldKey returns the API-direction HMAC signature using the
// bridge's previous (grace-window) HMAC key. Returns "" if there is
// no staged rotation. Used by R1.
func (f *FakeServer) SignWithOldKey(b Bridge, method, path, query, ts, nonce string, body []byte) string {
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	br, ok := f.state.bridges[b.ID]
	if !ok || len(br.oldHMACKey) == 0 {
		return ""
	}
	sig, err := polarissdk.Sign(polarissdk.CanonicalInput{
		Direction: polarissdk.DirectionAPI,
		Method:    method,
		Path:      path,
		Query:     query,
		TS:        ts,
		Nonce:     nonce,
		Body:      body,
	}, br.oldHMACKey)
	if err != nil {
		return ""
	}
	return sig
}

// PingHeartbeatWithKey POSTs a minimal heartbeat to the fake using a
// caller-supplied secret. Returns the HTTP status. Used by R1 / R4 to
// directly probe HMAC acceptance without involving the bridge's own
// signing.
func (f *FakeServer) PingHeartbeatWithKey(ctx context.Context, b Bridge, secret []byte) (int, error) {
	body, _ := json.Marshal(polarissdk.BridgeHeartbeatRequest{SchemaVersion: 2, BridgeVersion: "ping"})
	ts := polarissdk.NowMillis()
	nonce, err := polarissdk.GenerateNonce()
	if err != nil {
		return 0, err
	}
	sig, err := polarissdk.Sign(polarissdk.CanonicalInput{
		Direction: polarissdk.DirectionAPI,
		Method:    "POST",
		Path:      "/v1/bridge/heartbeat",
		Query:     "",
		TS:        ts,
		Nonce:     nonce,
		Body:      body,
	}, secret)
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", f.URL()+"/v1/bridge/heartbeat", strings.NewReader(string(body)))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Polaris-Bridge-Id", b.ID)
	req.Header.Set("X-Polaris-Ts", ts)
	req.Header.Set("X-Polaris-Nonce", nonce)
	req.Header.Set("X-Polaris-Sig", sig)
	resp, err := f.httpClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	return resp.StatusCode, nil
}

func (f *FakeServer) EnqueueDirective(b Bridge, d Directive) DirectiveID {
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	br, ok := f.state.bridges[b.ID]
	if !ok {
		return ""
	}
	id := f.state.nextID("dir")
	dir := polarissdk.BridgeDirective{
		ID:   id,
		Kind: d.Kind,
	}
	if d.Kind == "roll_hmac" {
		dir.NewHMACKey = d.NewHMACKey
		if !d.GraceExpiresAt.IsZero() {
			dir.GraceExpiresAt = d.GraceExpiresAt.UTC().Format(time.RFC3339)
		}
	}
	if d.Kind == "restart" {
		dir.QueuedAt = time.Now().UTC().Format(time.RFC3339)
	}
	br.pendingDirectives = append(br.pendingDirectives, dir)
	return DirectiveID(id)
}

func (f *FakeServer) StageHMACRotation(b Bridge, grace time.Duration) string {
	// randomKey already returns hex-encoded bytes ("ff04…" as []byte).
	// Both fake-stored key and bridge-on-disk key are these hex bytes;
	// signing uses them directly.
	newKey := randomKey()
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	br, ok := f.state.bridges[b.ID]
	if !ok {
		return ""
	}
	br.oldHMACKey = br.hmacKey
	br.hmacKey = newKey
	br.graceExpiresAt = time.Now().Add(grace)

	id := f.state.nextID("dir")
	dir := polarissdk.BridgeDirective{
		ID:             id,
		Kind:           "roll_hmac",
		NewHMACKey:     string(newKey),
		GraceExpiresAt: br.graceExpiresAt.UTC().Format(time.RFC3339),
	}
	br.pendingDirectives = append(br.pendingDirectives, dir)
	return string(newKey)
}

func (f *FakeServer) WebhookSecret(b Bridge) []byte {
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	if br, ok := f.state.bridges[b.ID]; ok {
		return copyBytes(br.webhookSecret)
	}
	return nil
}

func (f *FakeServer) WebhookURL(b Bridge) string {
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	if br, ok := f.state.bridges[b.ID]; ok {
		return br.webhookURL
	}
	return ""
}

func (f *FakeServer) PatchedFlags(b Bridge, messageID string) ([]string, bool) {
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	br, ok := f.state.bridges[b.ID]
	if !ok {
		return nil, false
	}
	flags, ok := br.patchedFlags[messageID]
	return flags, ok
}

func (f *FakeServer) DeletedMessage(b Bridge, messageID string) bool {
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	br, ok := f.state.bridges[b.ID]
	if !ok {
		return false
	}
	return br.deletedMessages[messageID]
}

func (f *FakeServer) SubmissionsFor(b Bridge) []SubmittedMessage {
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	br, ok := f.state.bridges[b.ID]
	if !ok {
		return nil
	}
	out := make([]SubmittedMessage, len(br.submissions))
	copy(out, br.submissions)
	return out
}

func (f *FakeServer) LogHighWater(b Bridge) int64 {
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	if br, ok := f.state.bridges[b.ID]; ok {
		return br.logHighWater
	}
	return 0
}

// -------- HTTP handlers --------

// handleHeartbeat absorbs the v2 heartbeat envelope, updates state, and
// returns the enable/settings/directives response.
func (f *FakeServer) handleHeartbeat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	bridgeID := r.Header.Get("X-Polaris-Bridge-Id")
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "read", http.StatusBadRequest)
		return
	}
	var req polarissdk.BridgeHeartbeatRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "decode: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.SchemaVersion != 2 {
		http.Error(w, "bridge image too old", http.StatusBadRequest)
		return
	}

	authKey := f.checkAuth(bridgeID, r, body)
	if authKey == AuthKeyRejected {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	f.state.mu.Lock()
	br, ok := f.state.bridges[bridgeID]
	if !ok {
		f.state.mu.Unlock()
		http.Error(w, "bridge not registered", http.StatusUnauthorized)
		return
	}

	// Inject a transient failure if scheduled.
	if br.heartbeatFailures > 0 {
		br.heartbeatFailures--
		f.state.mu.Unlock()
		http.Error(w, "injected failure", http.StatusInternalServerError)
		return
	}

	// Record the heartbeat.
	br.heartbeats = append(br.heartbeats, Heartbeat{
		ReceivedAt: time.Now(),
		AuthKey:    authKey,
		Request:    req,
	})
	br.heartbeatCount++

	// Track log delta.
	for _, l := range req.Logs {
		if l.Seq > br.logHighWater {
			br.logHighWater = l.Seq
		}
	}

	// Apply acks → mark applied + remove from pending.
	for _, ack := range req.DirectiveAcks {
		br.acked[ack.ID] = DirectiveAck{HeartbeatAt: time.Now(), Ack: ack}
		// Promote staged rotation when its roll_hmac directive is ack'd.
		if ack.Kind == "roll_hmac" {
			// Grace window can be cleared early — bridge confirmed it's
			// running on the new key.
			br.oldHMACKey = nil
			br.graceExpiresAt = time.Time{}
		}
		removeDirective(br, ack.ID)
	}

	// Build response BEFORE releasing the lock so concurrent state
	// changes don't race the snapshot.
	resp := polarissdk.BridgeHeartbeatResponse{
		Enabled:                !br.disabled,
		NextHeartbeatInSeconds: br.nextHeartbeatSeconds,
		Directives:             append([]polarissdk.BridgeDirective(nil), br.pendingDirectives...),
		LogHighWater:           br.logHighWater,
	}
	if br.disabled {
		reason := br.disabledReason
		resp.Reason = &reason
	}
	if br.settings.Version > req.SettingsVersion {
		s := br.settings
		resp.Settings = &s
	}

	// Signal anyone waiting for a heartbeat.
	f.state.cond.Broadcast()
	f.state.mu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

// handleBridgeConfig returns CF DNS token / FQDN / ACME email. We
// return empty CF token so the bridge runs without embedded ACME
// (relying on operator-mounted PEMs the harness wrote, or plaintext
// fallback if WithoutTLS=true).
func (f *FakeServer) handleBridgeConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	bridgeID := r.Header.Get("X-Polaris-Bridge-Id")
	if !f.bridgeExists(bridgeID) {
		http.Error(w, "bridge not registered", http.StatusUnauthorized)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"cf_dns_token": "",
		"cf_zone":      "mail.plrs.im",
		"fqdn":         f.bridgeName(bridgeID) + ".test",
		"acme_email":   "ops@test",
		"ts_authkey":   nil,
	})
}

// handleCredList implements the credstore poller endpoint —
// GET /v1/bridge/credentials?since=N. Returns one entry per username
// (the bridge's local credstore has a UNIQUE constraint on username,
// so we deduplicate the fake's protocol-keyed map down to one row
// per name). An incrementing mirror_version satisfies the poller's
// Ready signal.
func (f *FakeServer) handleCredList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	type cred struct {
		ID             string   `json:"id"`
		Username       string   `json:"username"`
		BcryptHash     string   `json:"bcrypt_hash"`
		AllowedSenders []string `json:"allowed_senders"`
		MirrorVersion  int64    `json:"mirror_version"`
	}
	type out struct {
		Updates       []cred   `json:"updates"`
		Deletions     []string `json:"deletions"`
		MirrorVersion int64    `json:"mirror_version"`
	}

	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	var resp out
	seen := map[string]bool{}
	for _, c := range f.state.credentials {
		if seen[c.username] {
			continue
		}
		seen[c.username] = true
		resp.Updates = append(resp.Updates, cred{
			ID:             c.id,
			Username:       c.username,
			BcryptHash:     c.bcryptHash,
			AllowedSenders: []string{}, // unrestricted
			MirrorVersion:  1,
		})
	}
	resp.MirrorVersion = 1
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

// handleCredLookup returns the credential row for (protocol, username).
func (f *FakeServer) handleCredLookup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	q := r.URL.Query()
	proto := q.Get("protocol")
	user := q.Get("username")

	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	c, ok := f.state.credentials[credKey(proto, user)]
	w.Header().Set("Content-Type", "application/json")
	if !ok {
		_ = json.NewEncoder(w).Encode(polarissdk.CredentialLookup{})
		return
	}
	_ = json.NewEncoder(w).Encode(polarissdk.CredentialLookup{
		ID: c.id, MailboxID: c.mailboxID, Protocol: c.protocol,
		AuthType: "password", Username: c.username, BcryptHash: c.bcryptHash,
	})
}

// handleWebhookSubs accepts POST /v1/admin/webhook-subs and stashes the
// per-bridge URL + secret on the bridge state.
func (f *FakeServer) handleWebhookSubs(w http.ResponseWriter, r *http.Request) {
	bridgeID := r.Header.Get("X-Polaris-Bridge-Id")
	switch r.Method {
	case http.MethodGet:
		// Bridge lists existing subs — we always return empty so the
		// bootstrap creates a new one with a fresh secret.
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{}})
		return
	case http.MethodPost:
		var req polarissdk.CreateWebhookSubRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "decode", http.StatusBadRequest)
			return
		}
		// randomKey already returns a hex-encoded byte slice; the bridge
		// uses the secret string verbatim as its HMAC key, so we send
		// the same bytes (no double-hex).
		secret := randomKey()
		f.state.mu.Lock()
		if br, ok := f.state.bridges[bridgeID]; ok {
			br.webhookSecret = secret
			br.webhookURL = req.URL
		}
		f.state.cond.Broadcast()
		f.state.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(polarissdk.CreateWebhookSubResponse{
			ID:     f.state.nextIDLocked("ws"),
			Secret: string(secret),
		})
		return
	default:
		http.Error(w, "method", http.StatusMethodNotAllowed)
	}
}

// nextIDLocked is callable when the caller doesn't hold the lock. The
// counter is a single int64, so atomicity is sufficient.
func (s *fakeState) nextIDLocked(prefix string) string {
	n := atomic.AddInt64(&s.idCounter, 1)
	return prefix + "-" + formatBase36(n)
}

// handleMessages — POST /v1/messages with Content-Type message/rfc822
// is the bridge's inbound submission. JSON shape submissions also
// terminate here in production, but the bridge only ever posts RFC822.
func (f *FakeServer) handleMessages(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	bridgeID := r.Header.Get("X-Polaris-Bridge-Id")
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "read", http.StatusBadRequest)
		return
	}
	id := f.state.nextIDLocked("submitted")
	f.state.mu.Lock()
	br, brOK := f.state.bridges[bridgeID]
	if brOK {
		br.submissions = append(br.submissions, SubmittedMessage{
			BridgeID:    bridgeID,
			ReceivedAt:  time.Now(),
			ContentType: r.Header.Get("Content-Type"),
			Body:        append([]byte(nil), body...),
			Headers:     captureHeaders(r),
		})
	}

	// Auto-route: if enabled for this bridge, parse the RFC822 To
	// header(s), create a new message in each matching seeded mailbox,
	// and queue a webhook delivery (off the lock so we don't deadlock
	// on httpClient.Do).
	var routedDeliveries []routedDelivery
	if brOK && br.autoRoute {
		rcpts := parseRecipientsLocked(body)
		for _, rcpt := range rcpts {
			mbID, ok := f.state.mailboxByOwner[rcpt]
			if !ok {
				continue
			}
			mbox := f.state.mailboxes[mbID]
			msgID := f.state.nextID("msg")
			uid := mbox.nextUID
			mbox.nextUID++
			mbox.changeID++
			mbox.messageOrder = append(mbox.messageOrder, msgID)
			subject := parseHeaderLocked(body, "Subject")
			fromAddr := parseHeaderLocked(body, "From")
			headerID := parseHeaderLocked(body, "Message-ID")
			if headerID == "" {
				headerID = fmt.Sprintf("<%s@auto-route>", msgID)
			}
			f.state.messages[msgID] = &messageState{
				id: msgID, mailboxID: mbID, uid: uid,
				subject: subject, fromAddr: fromAddr, headerID: headerID,
				bodyBytes: int64(len(body)),
				body:      append([]byte(nil), body...),
				createdAt: time.Now().UTC().Format(time.RFC3339),
				flags:     []string{},
			}
			if br.webhookURL != "" && len(br.webhookSecret) > 0 {
				routedDeliveries = append(routedDeliveries, routedDelivery{
					bridgeID:  bridgeID,
					mailboxID: mbID,
					messageID: msgID,
					subject:   subject,
				})
			}
		}
	}
	f.state.cond.Broadcast()
	f.state.mu.Unlock()

	// Fire webhooks AFTER releasing the lock (httpClient.Do may take a
	// few ms; holding the lock would serialize unrelated test traffic).
	for _, d := range routedDeliveries {
		go func(d routedDelivery) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = f.DeliverWebhook(ctx, Bridge{ID: d.bridgeID}, WebhookPayload{
				Event: "message.received",
				Message: polarissdk.Message{
					ID:        d.messageID,
					MailboxID: d.mailboxID,
					Subject:   d.subject,
				},
			})
		}(d)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(polarissdk.Message{
		ID: id, Status: "received",
	})
}

// routedDelivery captures the parameters of a queued auto-route webhook
// delivery. Used to release the fake's mu before doing network I/O.
type routedDelivery struct {
	bridgeID  string
	mailboxID string
	messageID string
	subject   string
}

// parseRecipientsLocked extracts recipient addresses from an RFC822
// body's To: header. Returns lowercased addresses for case-insensitive
// mailbox lookup. Caller must hold f.state.mu.
func parseRecipientsLocked(body []byte) []string {
	to := parseHeaderLocked(body, "To")
	if to == "" {
		return nil
	}
	var out []string
	for _, raw := range strings.Split(to, ",") {
		addr := strings.TrimSpace(raw)
		// Strip "Name <addr@host>" → "addr@host".
		if i := strings.IndexByte(addr, '<'); i >= 0 {
			if j := strings.IndexByte(addr[i:], '>'); j > 0 {
				addr = addr[i+1 : i+j]
			}
		}
		addr = strings.ToLower(strings.TrimSpace(addr))
		if addr != "" {
			out = append(out, addr)
		}
	}
	return out
}

// parseHeaderLocked extracts the first occurrence of the given header
// from an RFC822 body. Case-insensitive name match. Folded headers are
// joined back together. Caller must hold f.state.mu.
func parseHeaderLocked(body []byte, name string) string {
	prefix := strings.ToLower(name) + ":"
	for _, raw := range strings.Split(string(body), "\r\n") {
		if raw == "" {
			return ""
		}
		low := strings.ToLower(raw)
		if !strings.HasPrefix(low, prefix) {
			continue
		}
		return strings.TrimSpace(raw[len(prefix):])
	}
	return ""
}

// handleMessageItem covers PATCH /v1/messages/:id, DELETE /v1/messages/:id,
// and POST /v1/messages/get (since /v1/messages/get also matches the "/"
// suffix routing).
func (f *FakeServer) handleMessageItem(w http.ResponseWriter, r *http.Request) {
	bridgeID := r.Header.Get("X-Polaris-Bridge-Id")
	// Disambiguate /v1/messages/get from /v1/messages/:id.
	if r.URL.Path == "/v1/messages/get" {
		f.handleMessagesGet(w, r)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/v1/messages/")
	switch r.Method {
	case http.MethodPatch:
		var body struct {
			Flags []string `json:"flags"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.state.mu.Lock()
		if br, ok := f.state.bridges[bridgeID]; ok {
			br.patchedFlags[id] = append([]string{}, body.Flags...)
		}
		f.state.cond.Broadcast()
		f.state.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(polarissdk.Message{ID: id, Flags: body.Flags})
		return
	case http.MethodDelete:
		f.state.mu.Lock()
		if br, ok := f.state.bridges[bridgeID]; ok {
			br.deletedMessages[id] = true
		}
		f.state.cond.Broadcast()
		f.state.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
		return
	default:
		http.NotFound(w, r)
	}
}

func (f *FakeServer) handleMessagesGet(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		IDs []string `json:"ids"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	out := polarissdk.BulkGetResponse{}
	for _, id := range body.IDs {
		m, ok := f.state.messages[id]
		if !ok {
			out.NotFound = append(out.NotFound, id)
			continue
		}
		out.Data = append(out.Data, polarissdk.Message{
			ID: m.id, MailboxID: m.mailboxID, Subject: m.subject,
			From: m.fromAddr, FromAddr: m.fromAddr,
			HeaderMessageID: m.headerID, BodyBytes: m.bodyBytes,
			Flags: append([]string{}, m.flags...), Text: "stub body",
			CreatedAt: m.createdAt,
		})
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

// handleMailboxItem covers GET /v1/mailboxes/:id/changes,
// GET /v1/mailboxes/:id/messages, POST /v1/mailboxes/:id/expunge.
func (f *FakeServer) handleMailboxItem(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/v1/mailboxes/")
	parts := strings.SplitN(path, "/", 2)
	if len(parts) < 2 {
		http.NotFound(w, r)
		return
	}
	mailboxID := parts[0]
	rest := parts[1]
	switch rest {
	case "changes":
		f.handleMailboxChanges(w, r, mailboxID)
	case "messages":
		f.handleMailboxMessagesList(w, r, mailboxID)
	case "expunge":
		f.handleMailboxExpunge(w, r, mailboxID)
	default:
		http.NotFound(w, r)
	}
}

func (f *FakeServer) handleMailboxChanges(w http.ResponseWriter, r *http.Request, mailboxID string) {
	if r.Method != http.MethodGet {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	since, _ := strconv.ParseInt(r.URL.Query().Get("since_state"), 10, 64)
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	mb, ok := f.state.mailboxes[mailboxID]
	out := polarissdk.ChangesResponse{Added: []string{}, Updated: []string{}, Deleted: []string{}}
	if !ok {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(out)
		return
	}
	if since < mb.changeID {
		// Emit all live messages as "added"; deleted ones as "deleted".
		// Simple: real fanout would diff by changeID per message, the
		// fake doesn't need that fidelity.
		for _, id := range mb.messageOrder {
			if mb.deleted[id] {
				out.Deleted = append(out.Deleted, id)
			} else {
				out.Added = append(out.Added, id)
			}
		}
	}
	out.State = mb.changeID
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

func (f *FakeServer) handleMailboxMessagesList(w http.ResponseWriter, r *http.Request, mailboxID string) {
	if r.Method != http.MethodGet {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	mb, ok := f.state.mailboxes[mailboxID]
	out := polarissdk.MessageListResponse{}
	if ok {
		for _, id := range mb.messageOrder {
			if mb.deleted[id] {
				continue
			}
			m := f.state.messages[id]
			out.Data = append(out.Data, polarissdk.Message{
				ID: m.id, MailboxID: m.mailboxID, Subject: m.subject,
				From: m.fromAddr, FromAddr: m.fromAddr,
				HeaderMessageID: m.headerID, BodyBytes: m.bodyBytes,
				Flags: append([]string{}, m.flags...),
				CreatedAt: m.createdAt,
			})
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

func (f *FakeServer) handleMailboxExpunge(w http.ResponseWriter, r *http.Request, mailboxID string) {
	if r.Method != http.MethodPost {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	_ = mailboxID // we don't actually remove from the fake; bridge tracks expunged via DELETE
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(polarissdk.ExpungeResponse{Removed: 0})
}

// -------- Helpers --------

func (f *FakeServer) bridgeExists(id string) bool {
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	_, ok := f.state.bridges[id]
	return ok
}

func (f *FakeServer) bridgeName(id string) string {
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	if b, ok := f.state.bridges[id]; ok {
		return b.name
	}
	return id
}

// checkAuth verifies the HMAC signature and returns which key matched
// (current, grace, or rejected).
func (f *FakeServer) checkAuth(bridgeID string, r *http.Request, body []byte) AuthKey {
	if bridgeID == "" {
		return AuthKeyRejected
	}
	f.state.mu.Lock()
	br, ok := f.state.bridges[bridgeID]
	if !ok {
		f.state.mu.Unlock()
		return AuthKeyRejected
	}
	current := br.hmacKey
	old := br.oldHMACKey
	graceExpires := br.graceExpiresAt
	f.state.mu.Unlock()

	if verifyAPISig(r, body, current) {
		return AuthKeyCurrent
	}
	if old != nil && time.Now().Before(graceExpires) {
		if verifyAPISig(r, body, old) {
			return AuthKeyGrace
		}
	}
	return AuthKeyRejected
}

func verifyAPISig(r *http.Request, body []byte, secret []byte) bool {
	if len(secret) == 0 {
		return false
	}
	sig := r.Header.Get("X-Polaris-Sig")
	ts := r.Header.Get("X-Polaris-Ts")
	nonce := r.Header.Get("X-Polaris-Nonce")
	expected, err := polarissdk.Sign(polarissdk.CanonicalInput{
		Direction: polarissdk.DirectionAPI,
		Method:    r.Method,
		Path:      r.URL.Path,
		Query:     r.URL.RawQuery,
		TS:        ts,
		Nonce:     nonce,
		Body:      body,
	}, secret)
	if err != nil {
		return false
	}
	return sig == expected
}

func removeDirective(br *bridgeState, id string) {
	for i, d := range br.pendingDirectives {
		if d.ID == id {
			br.pendingDirectives = append(br.pendingDirectives[:i], br.pendingDirectives[i+1:]...)
			return
		}
	}
}

func captureHeaders(r *http.Request) map[string]string {
	out := map[string]string{}
	for k, v := range r.Header {
		if len(v) > 0 {
			out[k] = v[0]
		}
	}
	return out
}

// randomKey returns a 32-byte hex-encoded HMAC secret. We always
// hex-encode because the bridge's readKeyOrFile path trims whitespace
// off the file contents, and raw random bytes occasionally contain
// 0x20/0x09/0x0a/0x0d which would corrupt the key. Hex keeps every
// byte in [0-9a-f]. Both the bridge's HMAC client and the fake's
// HMAC verifier hold the same []byte ("ff04…" as raw bytes), so signing
// matches.
func randomKey() []byte {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Sprintf("mailtest: random: %v", err))
	}
	return []byte(hex.EncodeToString(b))
}

func copyBytes(b []byte) []byte {
	if b == nil {
		return nil
	}
	out := make([]byte, len(b))
	copy(out, b)
	return out
}

// DeliverWebhook signs and POSTs a webhook envelope to the bridge's
// receiver. Returns the bridge response error, if any.
func (f *FakeServer) DeliverWebhook(ctx context.Context, b Bridge, payload WebhookPayload) error {
	url := f.WebhookURL(b)
	if url == "" {
		return errors.New("mailtest: webhook url not yet bootstrapped")
	}
	secret := f.WebhookSecret(b)
	if len(secret) == 0 {
		return errors.New("mailtest: webhook secret not yet bootstrapped")
	}

	env := polarissdk.WebhookEnvelope{
		EventID:    payload.EventID,
		Event:      payload.Event,
		OccurredAt: payload.OccurredAt.UTC().Format(time.RFC3339Nano),
		Message:    payload.Message,
	}
	if env.EventID == "" {
		env.EventID = hex.EncodeToString(randomKey()[:12])
	}
	if payload.OccurredAt.IsZero() {
		env.OccurredAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	bodyBytes, err := json.Marshal(env)
	if err != nil {
		return err
	}

	// Sign as webhook direction.
	ts := polarissdk.NowMillis()
	nonce, err := polarissdk.GenerateNonce()
	if err != nil {
		return err
	}
	path := pathOf(url)
	sig, err := polarissdk.Sign(polarissdk.CanonicalInput{
		Direction: polarissdk.DirectionWebhook,
		Method:    "POST",
		Path:      path,
		Query:     "",
		TS:        ts,
		Nonce:     nonce,
		Body:      bodyBytes,
	}, secret)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", url, strings.NewReader(string(bodyBytes)))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Polaris-Ts", ts)
	req.Header.Set("X-Polaris-Nonce", nonce)
	req.Header.Set("X-Polaris-Sig", sig)
	req.Header.Set("X-Polaris-Event-Id", env.EventID)
	req.Header.Set("X-Polaris-Event", env.Event)
	resp, err := f.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("mailtest: webhook delivery: status %d", resp.StatusCode)
	}
	return nil
}

// DeliverWebhookRaw POSTs a webhook with caller-supplied signing
// material. Use when a test needs to control ts/nonce/sig explicitly
// (replay tests, ts-skew tests). Returns the HTTP status code.
func (f *FakeServer) DeliverWebhookRaw(
	ctx context.Context,
	b Bridge,
	body []byte,
	ts, nonce, sig string,
) (int, error) {
	url := f.WebhookURL(b)
	if url == "" {
		return 0, errors.New("mailtest: webhook url not yet bootstrapped")
	}
	req, err := http.NewRequestWithContext(ctx, "POST", url, strings.NewReader(string(body)))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Polaris-Ts", ts)
	req.Header.Set("X-Polaris-Nonce", nonce)
	req.Header.Set("X-Polaris-Sig", sig)
	resp, err := f.httpClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	return resp.StatusCode, nil
}

func pathOf(rawURL string) string {
	// Naive: strip "http(s)://host[:port]" prefix.
	for _, scheme := range []string{"https://", "http://"} {
		if strings.HasPrefix(rawURL, scheme) {
			rest := rawURL[len(scheme):]
			if idx := strings.Index(rest, "/"); idx >= 0 {
				return rest[idx:]
			}
			return "/"
		}
	}
	return rawURL
}
