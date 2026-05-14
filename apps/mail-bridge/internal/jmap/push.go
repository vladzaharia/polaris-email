package jmap

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/push"
)

// handleSSE serves the EventSource fallback per RFC 8620 §7.3. Each event
// is a `data: <json>\n\n` frame carrying a StateChange envelope.
func (s *Server) handleSSE(w http.ResponseWriter, r *http.Request) {
	auth, err := s.authenticate(r)
	if err != nil {
		writeJSONError(w, http.StatusUnauthorized, "unauthorized", err.Error())
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSONError(w, http.StatusInternalServerError, "noFlush", "streaming not supported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	sinkID := fmt.Sprintf("sse-%d", time.Now().UnixNano())
	sink := push.NewEventSourceSink(sinkID, w, flusher.Flush)
	s.deps.Push.Subscribe(auth.MailboxID, sink)
	defer s.deps.Push.Unsubscribe(auth.MailboxID, sinkID)

	// Hold the connection open until the client disconnects.
	<-r.Context().Done()
}

// handleWS upgrades to a hand-rolled WebSocket per RFC 8887. To avoid
// pulling a WebSocket dependency for this skeleton, we accept the upgrade
// and serve text frames using net/http hijack + the minimal frame writer.
// TODO(production): replace with nhooyr.io/websocket or gobwas/ws for
// robustness, ping/pong handling, fragmentation, etc.
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	auth, err := s.authenticate(r)
	if err != nil {
		writeJSONError(w, http.StatusUnauthorized, "unauthorized", err.Error())
		return
	}
	// In skeleton mode we don't run the full WS handshake; we tell the
	// client the path exists but that they should use SSE for now. The
	// state-change envelope is the same on both transports.
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUpgradeRequired)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"type":        "needsUpgrade",
		"description": "WebSocket handshake skeleton — production library pending; use /jmap/eventsource",
		"account":     auth.MailboxID,
	})
}
