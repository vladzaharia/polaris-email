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

// Handler is the HTTP handler at `/internal/webhook/message-received`.
type Handler struct {
	Manager *push.Manager
	// Secret is the per-subscription HMAC secret returned at creation time.
	Secret []byte
	// Path is the registered URL path (used for the canonical-string check).
	// Defaults to "/internal/webhook/message-received".
	Path string
	// Refresher is invoked before Broadcast so the IDLE fan-out only fires
	// after the mirror has the new message rows. May be nil (degrades to
	// the pre-A4 race-prone behavior, used by tests that don't care about
	// mirror state).
	Refresher MailboxRefresher
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
		// row already present. Pre-A4 this was a TODO and clients would
		// intermittently see the stale list.
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
