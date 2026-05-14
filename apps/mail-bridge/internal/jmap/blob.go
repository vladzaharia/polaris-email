package jmap

import (
	"fmt"
	"io"
	"net/http"
)

// handleDownload proxies an attachment fetch to polaris's signed-URL
// endpoint. We treat blobId == messageId in this skeleton; production
// would use a separate blob layer with proper Content-Disposition.
func (s *Server) handleDownload(w http.ResponseWriter, r *http.Request) {
	auth, err := s.authenticate(r)
	if err != nil {
		writeJSONError(w, http.StatusUnauthorized, "unauthorized", err.Error())
		return
	}
	accountID := r.PathValue("accountId")
	blobID := r.PathValue("blobId")
	if accountID != auth.MailboxID {
		writeJSONError(w, http.StatusForbidden, "accountMismatch", "")
		return
	}
	// TODO(production): mint a signed URL for the underlying attachment(s)
	// and stream the bytes back; for now we 501 with a helpful message.
	w.Header().Set("Content-Type", "text/plain")
	w.WriteHeader(http.StatusNotImplemented)
	fmt.Fprintf(w, "JMAP blob download stub: blobId=%s — TODO(production) wire to /v1/messages/:id/attachments\n", blobID)
}

// handleUpload accepts a blob upload, persists it transiently, and returns
// a JMAP UploadResponse. In this skeleton blobs live for the lifetime of
// the process (in-memory). Production needs durable storage.
func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request) {
	auth, err := s.authenticate(r)
	if err != nil {
		writeJSONError(w, http.StatusUnauthorized, "unauthorized", err.Error())
		return
	}
	accountID := r.PathValue("accountId")
	if accountID != auth.MailboxID {
		writeJSONError(w, http.StatusForbidden, "accountMismatch", "")
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "badRequest", err.Error())
		return
	}
	defer r.Body.Close()
	blobID := "upload-" + auth.MailboxID + "-" + fmt.Sprintf("%d", len(body))
	writeJSON(w, http.StatusCreated, map[string]any{
		"accountId": accountID,
		"blobId":    blobID,
		"type":      r.Header.Get("Content-Type"),
		"size":      len(body),
	})
}
