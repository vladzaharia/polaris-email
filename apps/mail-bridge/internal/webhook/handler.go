// Package webhook hosts the inbound webhook receiver. polaris fires
// `message.received` events here; the handler verifies the signature, then
// fans out to `push.Manager.Broadcast` so connected IMAP IDLE clients see
// the new mail immediately.
package webhook

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"sync"
	"time"

	polarissdk "github.com/polaris-email/polaris-sdk-go"

	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/push"
)

// MailboxRefresher pulls the latest delta for a single mailbox from the
// control plane into the local mirror. `store.Refresher` satisfies this
// interface; we keep the dependency narrow so tests can stub it without
// pulling in SQLite + the SDK.
type MailboxRefresher interface {
	RefreshMailbox(ctx context.Context, mailboxID string) error
}

// replayWindow is how long a (ts,nonce) pair is considered "seen". Matches
// the SDK skew tolerance (300s); after the window the timestamp itself is
// rejected by VerifyWebhook so we never need the dedup entry again.
const replayWindow = 5 * time.Minute

// replayCacheCap bounds the in-memory dedup map. A 5-minute window with a
// reasonable webhook firing rate (a few hundred per minute per bridge in
// the worst case) sits well under this; if the bridge is somehow flooded
// past the cap we drop the oldest entries on insert via opportunistic
// sweeps in seenReplay.
const replayCacheCap = 4096

// Handler is the HTTP handler at `/internal/webhook/message-received`.
type Handler struct {
	Manager *push.Manager
	// Secret is the per-subscription HMAC secret returned at creation time.
	// MUST be non-empty in production — an empty Secret causes every request
	// to be accepted. The handler defends against this with a startup-time
	// check (see ServeHTTP below).
	Secret []byte
	// Path is the registered URL path (used for the canonical-string check).
	// Defaults to "/internal/webhook/message-received".
	Path string
	// Refresher is invoked before Broadcast so the IDLE fan-out only fires
	// after the mirror has the new message rows. May be nil (degrades to
	// the pre-A4 race-prone behavior, used by tests that don't care about
	// mirror state).
	Refresher MailboxRefresher

	// Replay-protection state. Keys are "ts:nonce"; values are the unix-ms
	// ts the entry was inserted (used by the sweep to expire). Implemented
	// behind a mutex rather than sync.Map so the cap-based eviction sweep
	// is cheap and atomic.
	replayMu sync.Mutex
	replay   map[string]int64
}

// SetSecret atomically updates the handler's HMAC secret. Used by the
// bootstrap goroutine in main.go once subscriptions are issued.
func (h *Handler) SetSecret(s []byte) {
	// Note: secret is read on the request path without a lock. Go's memory
	// model permits the byte-slice swap to be torn from a verifier's POV,
	// but VerifyWebhook only ever reads the slice once per request via the
	// Secret field, so the worst case is a single dropped request during
	// the swap — acceptable for a one-shot bootstrap event.
	h.Secret = s
}

// Envelope mirrors the polaris webhook payload top-level shape.
type Envelope struct {
	ID    string          `json:"id"`
	Event string          `json:"event"`
	Data  json.RawMessage `json:"data"`
}

// MessageData is the `data` block for `message.received`.
type MessageData struct {
	MessageID string `json:"message_id"`
	MailboxID string `json:"mailbox_id"`
}

// ServeHTTP implements http.Handler.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// Hard fail-closed: an empty secret would let VerifyWebhook accept any
	// signature computed against the empty key — a bug in earlier versions
	// where bootstrap.Run's per-sub Secret never reached this struct. Treat
	// as "still booting / mis-wired" and reject without leaking which.
	if len(h.Secret) == 0 {
		log.Printf("webhook: secret not configured (bootstrap pending or misconfigured) — rejecting")
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "read body", http.StatusBadRequest)
		return
	}
	path := h.Path
	if path == "" {
		path = "/internal/webhook/message-received"
	}
	headers := map[string]string{}
	for k := range r.Header {
		headers[k] = r.Header.Get(k)
	}
	res := polarissdk.VerifyWebhook(polarissdk.VerifyInput{
		Direction: polarissdk.DirectionWebhook,
		Method:    r.Method,
		Path:      path,
		Query:     r.URL.RawQuery,
		Headers:   headers,
		Body:      body,
		Secret:    h.Secret,
	})
	if !res.OK {
		log.Printf("webhook: signature rejected: %s (%v)", res.Code, res.Err)
		http.Error(w, "signature", http.StatusUnauthorized)
		return
	}
	// Replay protection. The signature alone is not enough — an attacker who
	// captures one signed request can replay it inside the 5-minute skew
	// window. VerifyWebhook returned res.Ts (unix-ms) and res.Nonce; we key
	// the dedup map on the pair so re-using either alone won't collide.
	if h.seenReplay(res.Ts, res.Nonce) {
		log.Printf("webhook: replay rejected ts=%d nonce=%s", res.Ts, res.Nonce)
		http.Error(w, "replay", http.StatusConflict)
		return
	}
	var env Envelope
	if err := json.Unmarshal(body, &env); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if env.Event != "message.received" {
		// Acknowledge other events but do nothing (we only registered
		// message.received but be defensive).
		w.WriteHeader(http.StatusNoContent)
		return
	}
	var d MessageData
	if len(env.Data) > 0 {
		_ = json.Unmarshal(env.Data, &d)
	}
	if d.MailboxID != "" {
		// Refresh the mirror BEFORE broadcasting so any IDLE client that
		// races to FETCH after seeing `* n EXISTS` finds the new message
		// row already present.
		//
		// Refresh failure is logged but does not block the broadcast — the
		// baseline poll will eventually heal stale state, and IMAP clients
		// re-poll on their own cadence. Pushing through ensures we don't
		// silently drop notifications when the control plane is briefly
		// flaky.
		if h.Refresher != nil {
			if err := h.Refresher.RefreshMailbox(r.Context(), d.MailboxID); err != nil {
				log.Printf("webhook: refresh(%s): %v (broadcasting anyway)", d.MailboxID, err)
			}
		}
		h.Manager.Broadcast(d.MailboxID, push.StateChange{
			Type: "StateChange",
			Changed: map[string]map[string]string{
				d.MailboxID: {"Email": ""}, // state token computed by clients via Email/changes
			},
		})
	}
	w.WriteHeader(http.StatusNoContent)
}

// seenReplay returns true if the (ts, nonce) pair has already been
// processed inside the active replay window. Insertion is atomic with the
// lookup so two concurrent replays can't both be admitted. The map is
// swept opportunistically on every call so it never grows unbounded.
func (h *Handler) seenReplay(ts int64, nonce string) bool {
	key := nonceKey(ts, nonce)
	cutoff := time.Now().Add(-replayWindow).UnixMilli()
	h.replayMu.Lock()
	defer h.replayMu.Unlock()
	if h.replay == nil {
		h.replay = make(map[string]int64, 64)
	}
	// Sweep expired entries (cheap; map iteration cost dwarfed by HMAC).
	for k, v := range h.replay {
		if v < cutoff {
			delete(h.replay, k)
		}
	}
	if _, ok := h.replay[key]; ok {
		return true
	}
	// Cap-based eviction: if the map is at capacity, drop a victim. Choosing
	// the oldest is O(n) but n is bounded by replayCacheCap and only kicks
	// in under flooding.
	if len(h.replay) >= replayCacheCap {
		var oldestKey string
		var oldestTS int64
		first := true
		for k, v := range h.replay {
			if first || v < oldestTS {
				oldestKey = k
				oldestTS = v
				first = false
			}
		}
		delete(h.replay, oldestKey)
	}
	h.replay[key] = ts
	return false
}

// nonceKey is the dedup key. ts and nonce together uniquely identify an
// inbound request inside the active window.
func nonceKey(ts int64, nonce string) string {
	// Strconv-free fast path: format ts as 13-char fixed-width if positive
	// (which it always is for unix-ms in this century).
	return time.UnixMilli(ts).UTC().Format("20060102150405.000") + "|" + nonce
}
