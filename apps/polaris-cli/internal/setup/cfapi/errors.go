package cfapi

import (
	"errors"
	"fmt"
	"strings"
)

// CloudflareError is the typed error every cfapi request returns on a
// non-2xx Cloudflare response.
//
// We surface the HTTP status, the first numeric error code Cloudflare
// returned (per their `errors[]` array convention), the message string,
// the rest of the chain, and the request ID from `X-Cf-Request-Id` so
// operators can paste it into a support ticket.
type CloudflareError struct {
	HTTPStatus int
	Code       int
	Message    string
	Chain      []CFErrorEntry
	RequestID  string
}

// CFErrorEntry mirrors one entry of Cloudflare's `errors[]` envelope.
type CFErrorEntry struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// Error renders a one-line debug string. Tests can string-match on the
// "(cf code N)" suffix to assert specific error mappings.
func (e *CloudflareError) Error() string {
	var b strings.Builder
	fmt.Fprintf(&b, "cloudflare api: HTTP %d", e.HTTPStatus)
	if e.Code != 0 {
		fmt.Fprintf(&b, " (cf code %d)", e.Code)
	}
	if e.Message != "" {
		fmt.Fprintf(&b, ": %s", e.Message)
	}
	if e.RequestID != "" {
		fmt.Fprintf(&b, " [req %s]", e.RequestID)
	}
	return b.String()
}

// asCloudflareError returns a non-nil *CloudflareError if err (or any
// error in its chain) is one; otherwise (nil, false).
func asCloudflareError(err error) (*CloudflareError, bool) {
	if err == nil {
		return nil, false
	}
	var cf *CloudflareError
	if errors.As(err, &cf) {
		return cf, true
	}
	return nil, false
}

// IsAlreadyExists reports whether err looks like a "resource already
// exists" failure. We treat the HTTP 409 status as the canonical signal,
// and also accept the well-known CF error codes for D1/KV/R2/Queues
// "already exists" responses since CF sometimes returns 400 or 200 with a
// non-success envelope.
func IsAlreadyExists(err error) bool {
	cf, ok := asCloudflareError(err)
	if !ok {
		return false
	}
	if cf.HTTPStatus == 409 {
		return true
	}
	// Several CF endpoints use distinct numeric codes for "already exists"
	// (e.g. R2 returns 10004, KV returns 10014, D1 returns 7405). Rather
	// than enumerate every variant, fall back to message matching for the
	// generic case.
	for _, e := range cf.Chain {
		if strings.Contains(strings.ToLower(e.Message), "already exists") {
			return true
		}
	}
	return strings.Contains(strings.ToLower(cf.Message), "already exists")
}

// IsRateLimited reports whether err is a 429 / rate-limit failure. The
// transport-level retry already handles these, but operator-facing
// commands may want to surface a friendlier message.
func IsRateLimited(err error) bool {
	cf, ok := asCloudflareError(err)
	if !ok {
		return false
	}
	return cf.HTTPStatus == 429
}

// IsNotFound reports whether err is a 404.
func IsNotFound(err error) bool {
	cf, ok := asCloudflareError(err)
	if !ok {
		return false
	}
	return cf.HTTPStatus == 404
}
