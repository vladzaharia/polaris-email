// Typed error model for the polaris-email API. Callers can use `errors.As`
// to recover the parsed envelope and `IsRetryable` to honor the
// CONSUMER-CONTRACT.md retry rules programmatically.
//
// Wire shape (per docs/errors.md):
//
//	{ "error": { "code": "...", "message": "...", "retryable": bool, "request_id": "..." } }
//
// On non-2xx responses the SDK parses the envelope and returns *APIError.
// If parsing fails (e.g. a CF/edge 502 returning HTML), the SDK still returns
// *APIError with Code "unknown", Retryable derived from the HTTP status
// (>=500), and RequestID taken from the X-Request-Id header if present.
//
// Network errors (timeouts, connection refused, context cancellation) are
// returned wrapped unchanged so callers using `errors.Is(err,
// context.DeadlineExceeded)` continue to work. `IsRetryable` returns true for
// timeouts and temporary net.Error values.
package polarissdk

import (
	"encoding/json"
	"errors"
	"net"
	"net/http"
)

// APIError is the typed error returned by SDK calls when the API responds
// non-2xx. Code values are stable per docs/errors.md and CONSUMER-CONTRACT.md.
type APIError struct {
	// Code is the stable error code, e.g. "rate_limited". On a parse failure
	// (non-JSON body) the SDK sets Code to "unknown".
	Code string
	// Message is the human-readable explanation from the API.
	Message string
	// Status is the HTTP status code.
	Status int
	// Retryable reflects the API's signal — true means "safe to retry per
	// CONSUMER-CONTRACT.md". Callers should honor it directly.
	Retryable bool
	// RequestID is the X-Request-Id correlation id (or the envelope's
	// request_id), empty when neither is present.
	RequestID string
}

// Error implements the error interface.
func (e *APIError) Error() string {
	if e == nil {
		return "<nil>"
	}
	if e.Message != "" {
		return "polaris: " + e.Code + ": " + e.Message
	}
	return "polaris: " + e.Code
}

// envelope is the wire shape returned by the API.
type envelope struct {
	Error struct {
		Code      string `json:"code"`
		Message   string `json:"message"`
		Retryable bool   `json:"retryable"`
		RequestID string `json:"request_id"`
	} `json:"error"`
}

// ParseAPIError converts a non-2xx HTTP response into an *APIError.
//
// The body is parsed for the standard envelope. If parsing fails or the
// envelope is empty (no code), the resulting APIError has Code "unknown",
// Retryable = (status >= 500), and RequestID drawn from the X-Request-Id
// response header. Callers may pass a nil header map.
func ParseAPIError(status int, body []byte, headers http.Header) *APIError {
	requestID := ""
	if headers != nil {
		requestID = headers.Get("X-Request-Id")
	}
	if len(body) > 0 {
		var env envelope
		if err := json.Unmarshal(body, &env); err == nil && env.Error.Code != "" {
			rid := env.Error.RequestID
			if rid == "" {
				rid = requestID
			}
			return &APIError{
				Code:      env.Error.Code,
				Message:   env.Error.Message,
				Status:    status,
				Retryable: env.Error.Retryable,
				RequestID: rid,
			}
		}
	}
	return &APIError{
		Code:      "unknown",
		Message:   string(body),
		Status:    status,
		Retryable: status >= 500,
		RequestID: requestID,
	}
}

// AsAPIError unwraps err to an *APIError, returning (apiErr, true) if the
// chain contains one. A thin convenience over errors.As for callers that want
// a single-call lookup.
func AsAPIError(err error) (*APIError, bool) {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		return apiErr, true
	}
	return nil, false
}

// IsRetryable reports whether err is safe to retry per CONSUMER-CONTRACT.md.
//
//   - *APIError values defer to the API's Retryable flag.
//   - net.Error values report true when Timeout() is true (and for legacy
//     temporary errors).
//   - All other errors return false (unknown is treated as not safe).
func IsRetryable(err error) bool {
	if err == nil {
		return false
	}
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		return apiErr.Retryable
	}
	var netErr net.Error
	if errors.As(err, &netErr) {
		if netErr.Timeout() {
			return true
		}
		// net.Error.Temporary() is deprecated but some transports still set
		// it; honor it as a hint.
		type temporary interface{ Temporary() bool }
		if t, ok := err.(temporary); ok && t.Temporary() { //nolint:staticcheck
			return true
		}
	}
	return false
}
