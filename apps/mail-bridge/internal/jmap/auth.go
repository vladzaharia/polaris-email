package jmap

import (
	"errors"
	"net/http"
	"strings"
)

// AuthContext describes an authenticated JMAP session.
type AuthContext struct {
	Username  string
	MailboxID string
}

// authenticate extracts and verifies the bearer token from the request.
// Returns an AuthContext on success or an error suitable for a 401.
func (s *Server) authenticate(r *http.Request) (*AuthContext, error) {
	authz := r.Header.Get("Authorization")
	if authz == "" {
		return nil, errors.New("missing Authorization header")
	}
	parts := strings.SplitN(authz, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return nil, errors.New("only Bearer auth is supported")
	}
	token := strings.TrimSpace(parts[1])
	if token == "" {
		return nil, errors.New("empty bearer token")
	}
	cred, err := s.deps.Client.LookupMailboxCredential(r.Context(), "jmap", token)
	if err != nil {
		return nil, err
	}
	if cred == nil || cred.AuthType != "bearer_token" {
		return nil, errors.New("invalid bearer token")
	}
	// The bearer token IS the username field for JMAP creds — the API stores
	// it verbatim in `bearer_token`. We compare here for an extra check.
	if cred.BearerToken != "" && cred.BearerToken != token {
		return nil, errors.New("token mismatch")
	}
	return &AuthContext{Username: cred.Username, MailboxID: cred.MailboxID}, nil
}
