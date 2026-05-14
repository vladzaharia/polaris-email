// Package webhook hosts the inbound webhook receiver. polaris fires
// `message.received` events here; the handler verifies the signature, then
// fans out to `push.Manager.Broadcast` so connected IMAP IDLE / JMAP push
// clients see the new mail immediately.
package webhook

import (
	"encoding/json"
	"io"
	"log"
	"net/http"

	polarissdk "github.com/polaris-email/polaris-sdk-go"

	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/push"
)

// Handler is the HTTP handler at `/internal/webhook/message-received`.
type Handler struct {
	Manager *push.Manager
	// Secret is the per-subscription HMAC secret returned at creation time.
	Secret []byte
	// Path is the registered URL path (used for the canonical-string check).
	// Defaults to "/internal/webhook/message-received".
	Path string
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
	res := polarissdk.VerifyWebhookFull(polarissdk.VerifyInput{
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
		h.Manager.Broadcast(d.MailboxID, push.StateChange{
			Type: "StateChange",
			Changed: map[string]map[string]string{
				d.MailboxID: {"Email": ""}, // state token computed by clients via Email/changes
			},
		})
	}
	w.WriteHeader(http.StatusNoContent)
}
