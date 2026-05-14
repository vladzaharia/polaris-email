package jmap

import (
	"context"
	"encoding/json"
	"net/http"
)

// Session is the JMAP session object (RFC 8620 §2).
type Session struct {
	Capabilities    map[string]any     `json:"capabilities"`
	Accounts        map[string]Account `json:"accounts"`
	PrimaryAccounts map[string]string  `json:"primaryAccounts"`
	Username        string             `json:"username"`
	APIURL          string             `json:"apiUrl"`
	DownloadURL     string             `json:"downloadUrl"`
	UploadURL       string             `json:"uploadUrl"`
	EventSourceURL  string             `json:"eventSourceUrl"`
	WebSocketURL    string             `json:"webSocketUrl"`
	State           string             `json:"state"`
}

// Account is one entry in Session.Accounts.
type Account struct {
	Name                string         `json:"name"`
	IsPersonal          bool           `json:"isPersonal"`
	IsReadOnly          bool           `json:"isReadOnly"`
	AccountCapabilities map[string]any `json:"accountCapabilities"`
}

// handleWellKnown redirects to the session URL per RFC 8620 §2.2.
func (s *Server) handleWellKnown(w http.ResponseWriter, r *http.Request) {
	http.Redirect(w, r, s.opts.SessionURL+"/jmap/session", http.StatusFound)
}

// handleSession returns the session object for an authenticated client.
func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) {
	auth, err := s.authenticate(r)
	if err != nil {
		writeJSONError(w, http.StatusUnauthorized, "unauthorized", err.Error())
		return
	}
	sess := s.buildSession(r.Context(), auth)
	writeJSON(w, http.StatusOK, sess)
}

func (s *Server) buildSession(_ context.Context, auth *AuthContext) Session {
	cap := map[string]any{
		"urn:ietf:params:jmap:core": map[string]any{
			"maxSizeUpload":         50 * 1024 * 1024,
			"maxSizeRequest":        10 * 1024 * 1024,
			"maxConcurrentRequests": 4,
			"maxCallsInRequest":     16,
			"collationAlgorithms":   []string{"i;ascii-numeric", "i;ascii-casemap"},
		},
		"urn:ietf:params:jmap:mail": map[string]any{
			"maxMailboxesPerEmail":       1,
			"maxMailboxDepth":            1,
			"maxSizeMailboxName":         128,
			"maxSizeAttachmentsPerEmail": 25 * 1024 * 1024,
			"emailQuerySortOptions":      []string{"receivedAt"},
			"mayCreateTopLevelMailbox":   false,
		},
		"urn:ietf:params:jmap:submission": map[string]any{
			"maxDelayedSend":       0,
			"submissionExtensions": map[string]any{},
		},
		"urn:ietf:params:jmap:websocket": map[string]any{
			"url":          s.opts.SessionURL + "/jmap/ws",
			"supportsPush": true,
		},
	}
	return Session{
		Capabilities: cap,
		Accounts: map[string]Account{
			auth.MailboxID: {
				Name:       auth.Username,
				IsPersonal: true,
				IsReadOnly: false,
				AccountCapabilities: map[string]any{
					"urn:ietf:params:jmap:mail":       map[string]any{},
					"urn:ietf:params:jmap:submission": map[string]any{},
				},
			},
		},
		PrimaryAccounts: map[string]string{
			"urn:ietf:params:jmap:mail":       auth.MailboxID,
			"urn:ietf:params:jmap:submission": auth.MailboxID,
		},
		Username:       auth.Username,
		APIURL:         s.opts.SessionURL + "/jmap/api",
		DownloadURL:    s.opts.SessionURL + "/jmap/download/{accountId}/{blobId}/{name}",
		UploadURL:      s.opts.SessionURL + "/jmap/upload/{accountId}",
		EventSourceURL: s.opts.SessionURL + "/jmap/eventsource",
		WebSocketURL:   s.opts.SessionURL + "/jmap/ws",
		State:          "polaris-mail-bridge",
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeJSONError(w http.ResponseWriter, status int, typ, desc string) {
	writeJSON(w, status, map[string]string{
		"type":        typ,
		"description": desc,
	})
}
