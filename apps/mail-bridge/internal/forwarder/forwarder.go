// Package forwarder posts canonicalized RFC822 messages to the Polaris API.
//
// Phase F migration: this used to POST a JSON body to /v1/send/raw with a
// custom 5-line HMAC. It now POSTs raw RFC822 bytes to /v1/messages with
// `Content-Type: message/rfc822` via the shared polaris-sdk-go client, which
// performs the canonical 7-line HMAC over the body bytes.
package forwarder

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"sort"
	"strings"
	"time"

	polarissdk "github.com/polaris-mail/polaris-sdk-go"
)

// Config carries the fixed bits each Forward call needs.
type Config struct {
	APIURL             string
	HMACKey            []byte
	BridgeID           string
	AccessClientID     string
	AccessClientSecret string
	HTTPClient         *http.Client
}

// Forwarder posts to POST /v1/messages (message/rfc822).
type Forwarder struct {
	cfg    Config
	client *polarissdk.Client
}

// New creates a Forwarder.
func New(cfg Config) *Forwarder {
	httpClient := cfg.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 60 * time.Second}
	}
	c := polarissdk.NewClient(cfg.APIURL)
	c.HTTPClient = httpClient
	c.BridgeID = cfg.BridgeID
	c.BridgeSecret = cfg.HMACKey
	c.ExtraHeaders = map[string]string{
		"CF-Access-Client-Id":     cfg.AccessClientID,
		"CF-Access-Client-Secret": cfg.AccessClientSecret,
	}
	return &Forwarder{cfg: cfg, client: c}
}

// ForwardRequest is the input to Forward.
type ForwardRequest struct {
	EnvelopeFrom     string
	EnvelopeTo       []string
	RFC822           []byte
	SubmissionID     string
	ClientIP         string
	ReceivedAtBridge time.Time
}

// ForwardResult is the typed response.
type ForwardResult struct {
	StatusCode int
	Body       []byte
	// Category: "ok" (2xx), "transient" (4xx soft), "permanent" (4xx hard / 5xx).
	Category string
}

// Forward posts the request and returns a typed result.
func (f *Forwarder) Forward(ctx context.Context, in ForwardRequest) (*ForwardResult, error) {
	extra := map[string]string{
		"X-Polaris-Submission-Id":   in.SubmissionID,
		"X-Polaris-Client-IP":       in.ClientIP,
		"X-Polaris-Received-Bridge": in.ReceivedAtBridge.UTC().Format(time.RFC3339Nano),
		"Idempotency-Key":           idempotencyKey(in),
	}
	resp, body, err := f.client.Do(ctx, "POST", "/v1/messages", "", in.RFC822, "message/rfc822", extra)
	if err != nil {
		return nil, err
	}
	res := &ForwardResult{StatusCode: resp.StatusCode, Body: body}
	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		res.Category = "ok"
	case resp.StatusCode == http.StatusRequestTimeout,
		resp.StatusCode == http.StatusTooManyRequests,
		resp.StatusCode >= 500:
		res.Category = "transient"
	default:
		res.Category = "permanent"
	}
	return res, nil
}

// idempotencyKey derives a stable idempotency key for a ForwardRequest.
//
//   - If the RFC822 carries a syntactically-valid `Message-ID:` header
//     (RFC 5322 form `<local@domain>`), that value is used verbatim. Clients
//     retrying a submission preserve their Message-ID, so the API will
//     dedupe even across reconnects.
//   - Otherwise (no header, malformed, or suspicious shape) we derive a
//     hash of submission-identity bits that stay stable across retries of
//     the same logical submission, including a canonical (sorted) recipient
//     list so reordering RCPT TO doesn't produce a different key.
//
// Note: SubmissionID is intentionally NOT part of the key — it changes on
// every inbound SMTP session, so including it would defeat retry-dedupe.
func idempotencyKey(req ForwardRequest) string {
	if mid := extractMessageID(req.RFC822); mid != "" && isValidMessageID(mid) {
		return mid
	}
	date := extractHeader(req.RFC822, "Date")
	tos := append([]string(nil), req.EnvelopeTo...)
	sort.Strings(tos)
	toJoined := strings.Join(tos, ",")
	bodyHash := sha256.Sum256(req.RFC822)
	bodyHashShort := hex.EncodeToString(bodyHash[:])[:16]
	canonical := "polaris-smtp/" + req.EnvelopeFrom + "/" + toJoined + "/" + date + "/" + bodyHashShort
	sum := sha256.Sum256([]byte(canonical))
	return hex.EncodeToString(sum[:])
}

// isValidMessageID accepts RFC 5322 §3.6.4 shape `<local@domain>` with no
// control characters or whitespace and a reasonable size cap. The header
// value is user-controlled (a hostile sender can put anything there), and
// we forward it verbatim as an HTTP header, so the validator rejects values
// that could break header framing or be confused for a routing token.
func isValidMessageID(mid string) bool {
	if len(mid) < 3 || len(mid) > 998 {
		return false
	}
	if mid[0] != '<' || mid[len(mid)-1] != '>' {
		return false
	}
	inner := mid[1 : len(mid)-1]
	if !strings.Contains(inner, "@") {
		return false
	}
	for _, r := range inner {
		if r <= 0x20 || r == 0x7f {
			return false
		}
		if r == '<' || r == '>' || r == ',' || r == '\\' || r == '"' {
			return false
		}
	}
	return true
}

// extractMessageID returns the value of the first `Message-ID:` header found
// in the RFC822 bytes, with surrounding whitespace trimmed. Returns "" if not
// present. Stops scanning at the header/body separator (blank line).
//
// We accept simple line-folded continuations (a header line that starts with
// SP/HTAB extends the previous header). This is good enough for the SMTPS
// forwarder; we do not implement full RFC 5322 grammar — extreme edge cases
// (e.g. a Message-ID split across many folded lines with embedded comments)
// fall through to the hash-derived key, which is fine.
func extractMessageID(raw []byte) string {
	return extractHeader(raw, "Message-ID")
}

// extractHeader returns the (unfolded, trimmed) value of the first occurrence
// of `name` in the RFC822 headers of raw. Header name match is case-insensitive
// per RFC 5322 §1.2.2. Returns "" if absent.
func extractHeader(raw []byte, name string) string {
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	// Default Scanner buffer is 64 KiB; raise it so very long header lines
	// don't truncate.
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	wanted := strings.ToLower(name) + ":"
	var (
		inMatch bool
		value   strings.Builder
	)
	for scanner.Scan() {
		line := scanner.Text()
		// Blank line marks end of headers.
		if line == "" {
			break
		}
		// Continuation of the current header (folded line).
		if inMatch && (strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t")) {
			value.WriteString(" ")
			value.WriteString(strings.TrimSpace(line))
			continue
		}
		if inMatch {
			// We were tracking the matched header and a non-continuation line
			// arrived — we have its full value.
			break
		}
		// New header line — check name.
		lower := strings.ToLower(line)
		if strings.HasPrefix(lower, wanted) {
			inMatch = true
			value.WriteString(strings.TrimSpace(line[len(wanted):]))
		}
	}
	return strings.TrimSpace(value.String())
}
