package genesis

import (
	"encoding/json"
	"errors"
)

// AlreadyBootstrappedError is returned by Seal when the server reports
// 409 already_bootstrapped without a matching Idempotency-Key entry.
// The happy-path runner checks for this with IsAlreadyBootstrapped()
// and treats it as a clean skip (--force overrides).
type AlreadyBootstrappedError struct {
	Message string
}

// Error implements error.
func (e *AlreadyBootstrappedError) Error() string {
	if e == nil || e.Message == "" {
		return "genesis: bootstrap already completed"
	}
	return "genesis: " + e.Message
}

// IsAlreadyBootstrapped reports whether err (or anything wrapped by it
// via errors.Unwrap) is an *AlreadyBootstrappedError. Mirrors the
// errors.Is convention; useful when the seal flow is invoked from the
// happy-path runner and we want a typed branch on "the genesis row is
// already there, skip the phase".
func IsAlreadyBootstrapped(err error) bool {
	if err == nil {
		return false
	}
	var target *AlreadyBootstrappedError
	return errors.As(err, &target)
}

// decodeAlreadyBootstrapped parses the server's error envelope and
// returns a typed AlreadyBootstrappedError. We bias toward the error
// even when the envelope is malformed — a 409 with an unparseable body
// is still a 409, and the caller should treat it as the bootstrap-was-
// already-consumed branch.
func decodeAlreadyBootstrapped(body []byte) error {
	var env struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		return &AlreadyBootstrappedError{Message: "bootstrap already completed"}
	}
	if env.Error.Code != "already_bootstrapped" && env.Error.Code != "conflict" {
		// 409 without the expected code — surface a generic error
		// rather than masking a different conflict shape.
		return errors.New("genesis: bootstrap returned 409: " + env.Error.Message)
	}
	return &AlreadyBootstrappedError{Message: env.Error.Message}
}
