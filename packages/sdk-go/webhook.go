// Package polarissdk provides the Go SDK for polaris-email.
//
// All files in this package are **hand-written** and kept in sync with
// `openapi/polaris-email.yaml` manually (see `docs/sdk.md` for the
// contract). The prior `packages/sdk-codegen/` orchestrator was deleted
// in Phase M (commit 71f6e41); it never produced real output.
//
// `webhook.go` is the HMAC verifier; consumers receiving webhook
// deliveries should call `VerifyWebhook` (strict canonical-string form)
// to validate the request before trusting its body.
//
// `client.go` is the low-level HTTP client; it handles HMAC signing for
// the API direction. `messages.go` defines the typed request/response
// structs.
//
// BREAKING CHANGE (cleanup plan A9): the prior `VerifyWebhook(payload []byte,
// sigHeader, secret string) bool` short overload has been removed. It HMAC'd
// the raw payload — not the canonical string — and shared its name with the
// strict Python/TS verifiers, which made it a silent footgun for callers who
// expected canonical-string semantics. The strict verifier formerly named
// `VerifyWebhookFull` is now `VerifyWebhook` and is the only entry point.
//
// BREAKING CHANGE (cleanup plan B3): HMAC versioning removed entirely.
// Domain tags are now `polaris-api` / `polaris-webhook` (no `.v1`) and the
// `X-Polaris-Sig` header is bare lowercase hex (no `v1=`/`v2=` prefix). The
// AllowedAlgorithms field has been deleted; signatures shaped like `v1=…`
// or `v2=…` are rejected with `CodeInvalidSignature`.
package polarissdk

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Direction is the HMAC domain-separation tag.
type Direction string

const (
	DirectionAPI     Direction = "polaris-api"
	DirectionWebhook Direction = "polaris-webhook"
)

// VerifyInput carries the inputs needed to verify a single request signature.
type VerifyInput struct {
	Direction   Direction
	Method      string
	Path        string
	Query       string
	Headers     map[string]string
	Body        []byte
	Secret      []byte
	SkewSeconds int
	Now         time.Time
}

// VerifyCode is a stable error code returned in the Result for tests / log routing.
type VerifyCode string

const (
	CodeMissingHeader    VerifyCode = "missing_header"
	CodeHeaderInvalid    VerifyCode = "header_invalid"
	CodeClockSkew        VerifyCode = "clock_skew"
	CodeInvalidSignature VerifyCode = "invalid_signature"
)

// VerifyResult is the result of VerifyWebhook.
type VerifyResult struct {
	OK    bool
	Ts    int64
	Nonce string
	Code  VerifyCode
	Err   error
}

// VerifyWebhook performs the strict canonical-string verification used by the
// SDK tests and required for production use. The signature header is bare
// lowercase hex; prefixed forms (`v1=…` / `v2=…`) are rejected.
func VerifyWebhook(in VerifyInput) VerifyResult {
	if in.Direction == "" {
		in.Direction = DirectionWebhook
	}
	if in.Method == "" {
		in.Method = "POST"
	}
	skewSec := in.SkewSeconds
	if skewSec == 0 {
		skewSec = 300
	}
	now := in.Now
	if now.IsZero() {
		now = time.Now()
	}
	tsRaw, ok := pickHeader(in.Headers, "x-polaris-ts")
	if !ok {
		return VerifyResult{Code: CodeMissingHeader, Err: errors.New("X-Polaris-Ts")}
	}
	nonce, ok := pickHeader(in.Headers, "x-polaris-nonce")
	if !ok {
		return VerifyResult{Code: CodeMissingHeader, Err: errors.New("X-Polaris-Nonce")}
	}
	sig, ok := pickHeader(in.Headers, "x-polaris-sig")
	if !ok {
		return VerifyResult{Code: CodeMissingHeader, Err: errors.New("X-Polaris-Sig")}
	}
	// Empty values are detected explicitly because noCRLF treats them as
	// "invalid" but the resulting "crlf" message is misleading. Distinguishing
	// empty from CRLF makes the failure mode clear in audit logs.
	if tsRaw == "" {
		return VerifyResult{Code: CodeHeaderInvalid, Err: errors.New("ts empty")}
	}
	if nonce == "" {
		return VerifyResult{Code: CodeHeaderInvalid, Err: errors.New("nonce empty")}
	}
	if sig == "" {
		return VerifyResult{Code: CodeHeaderInvalid, Err: errors.New("sig empty")}
	}
	if !noCRLF(tsRaw) || !noCRLF(nonce) || !noCRLF(sig) {
		return VerifyResult{Code: CodeHeaderInvalid, Err: errors.New("crlf")}
	}
	// Bare lowercase hex only. Reject anything containing `=` or any
	// non-hex character (covers `v1=…`, `v2=…`, and similar prefixes).
	if !isLowerHex(sig) {
		return VerifyResult{Code: CodeInvalidSignature, Err: errors.New("sig format")}
	}
	ts, err := strconv.ParseInt(tsRaw, 10, 64)
	if err != nil {
		return VerifyResult{Code: CodeHeaderInvalid, Err: err}
	}
	nowMs := now.UnixMilli()
	if abs64(nowMs-ts) > int64(skewSec)*1000 {
		return VerifyResult{Code: CodeClockSkew, Err: errors.New("ts skew")}
	}
	if len(nonce) < 16 || len(nonce) > 128 {
		return VerifyResult{Code: CodeHeaderInvalid, Err: errors.New("nonce length")}
	}
	method := strings.ToUpper(in.Method)
	for _, c := range method {
		if c < 'A' || c > 'Z' {
			return VerifyResult{Code: CodeHeaderInvalid, Err: errors.New("method")}
		}
	}
	if !strings.HasPrefix(in.Path, "/") {
		return VerifyResult{Code: CodeHeaderInvalid, Err: errors.New("path")}
	}
	bh := sha256.Sum256(in.Body)
	bodyHex := hex.EncodeToString(bh[:])
	canonical := strings.Join([]string{
		string(in.Direction),
		method,
		in.Path,
		canonicalQuery(in.Query),
		tsRaw,
		nonce,
		bodyHex,
	}, "\n")
	mac := hmac.New(sha256.New, in.Secret)
	mac.Write([]byte(canonical))
	expected := mac.Sum(nil)
	provided, err := hex.DecodeString(sig)
	if err != nil || len(provided) != len(expected) || !hmac.Equal(expected, provided) {
		return VerifyResult{Code: CodeInvalidSignature, Err: errors.New("hmac mismatch")}
	}
	return VerifyResult{OK: true, Ts: ts, Nonce: nonce}
}

// VerifyAndParseWebhook verifies the request signature and, on success,
// parses the body into a typed WebhookEnvelope. The VerifyResult is always
// returned so callers can read Code/Err on failure; the envelope is non-nil
// only when verification succeeded *and* the body parsed cleanly.
//
// Convenience over the two-step VerifyWebhook → ParseWebhookEnvelope dance
// for the common case. Use the underlying primitives if you need to inspect
// the verified body before parsing it.
func VerifyAndParseWebhook(in VerifyInput) (*WebhookEnvelope, VerifyResult) {
	res := VerifyWebhook(in)
	if !res.OK {
		return nil, res
	}
	env, err := ParseWebhookEnvelope(in.Body)
	if err != nil {
		return nil, VerifyResult{
			OK:    false,
			Ts:    res.Ts,
			Nonce: res.Nonce,
			Code:  CodeHeaderInvalid,
			Err:   err,
		}
	}
	return env, res
}

func pickHeader(h map[string]string, name string) (string, bool) {
	for k, v := range h {
		if strings.EqualFold(k, name) {
			return v, true
		}
	}
	return "", false
}

func noCRLF(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r == '\r' || r == '\n' || r == 0 || r == '\t' || r == ' ' || r > 0x7e {
			return false
		}
	}
	return true
}

func isLowerHex(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}

// ---------- exported signing helpers (used by polaris-cli and bridge consumers) ----------

// CanonicalInput holds everything needed to build the canonical signing string.
type CanonicalInput struct {
	Direction Direction
	Method    string
	Path      string
	Query     string // raw query string (without leading "?")
	TS        string // unix milliseconds as decimal string
	Nonce     string
	Body      []byte
}

// BuildCanonical constructs the canonical string per the spec. Lower-cased
// HTTP method, RFC 3986 query canonicalization, and lowercase-hex body hash.
func BuildCanonical(in CanonicalInput) (string, error) {
	if err := AssertNoCrlf("ts", in.TS); err != nil {
		return "", err
	}
	if err := AssertNoCrlf("nonce", in.Nonce); err != nil {
		return "", err
	}
	method := strings.ToUpper(in.Method)
	for i := 0; i < len(method); i++ {
		c := method[i]
		if c < 'A' || c > 'Z' {
			return "", errors.New("hmac: invalid HTTP method")
		}
	}
	if !strings.HasPrefix(in.Path, "/") {
		return "", errors.New("hmac: path must start with /")
	}
	bodyHash := sha256.Sum256(in.Body)
	return strings.Join([]string{
		string(in.Direction),
		method,
		in.Path,
		CanonicalQuery(in.Query),
		in.TS,
		in.Nonce,
		hex.EncodeToString(bodyHash[:]),
	}, "\n"), nil
}

// Sign returns the bare lowercase-hex HMAC tag (no algorithm prefix).
func Sign(in CanonicalInput, secret []byte) (string, error) {
	canon, err := BuildCanonical(in)
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(canon))
	return hex.EncodeToString(mac.Sum(nil)), nil
}

// CanonicalQuery sorts query parameters by lowercase key, then value, and
// percent-encodes per RFC 3986 to match the TypeScript implementation.
func CanonicalQuery(raw string) string {
	return canonicalQuery(raw)
}

// AssertNoCrlf rejects strings containing whitespace, control characters, or
// non-ASCII bytes — matching the TS implementation's strict header guard.
func AssertNoCrlf(name, value string) error {
	if value == "" {
		return errors.New("hmac: " + name + " empty")
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		if c == 0x0a || c == 0x0d || c == 0x00 || c == 0x09 || c == 0x20 {
			return errors.New("hmac: " + name + " contains whitespace or control character")
		}
		if c > 0x7e {
			return errors.New("hmac: " + name + " non-ASCII")
		}
	}
	return nil
}

// GenerateNonce returns a 24-character Crockford base32 nonce derived from 15
// random bytes — matching the TS generator.
func GenerateNonce() (string, error) {
	b := make([]byte, 15)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return Crockford32(b), nil
}

const crockfordAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// Crockford32 encodes bytes using Crockford base32 (no padding).
func Crockford32(in []byte) string {
	var bits, acc uint32
	var sb strings.Builder
	for _, b := range in {
		acc = (acc << 8) | uint32(b)
		bits += 8
		for bits >= 5 {
			bits -= 5
			sb.WriteByte(crockfordAlphabet[(acc>>bits)&31])
		}
	}
	if bits > 0 {
		sb.WriteByte(crockfordAlphabet[(acc<<(5-bits))&31])
	}
	return sb.String()
}

// NowMillis returns the current time as a unix-ms decimal string.
func NowMillis() string {
	return strconv.FormatInt(time.Now().UnixMilli(), 10)
}

// ---------- internal canonical-query helper (kept private so it can keep the
// minimal API surface; CanonicalQuery is the public wrapper) ----------

func canonicalQuery(raw string) string {
	if raw == "" {
		return ""
	}
	raw = strings.TrimPrefix(raw, "?")
	if raw == "" {
		return ""
	}
	values, err := url.ParseQuery(raw)
	if err != nil {
		return ""
	}
	type kv struct{ K, V string }
	var pairs []kv
	for k, vs := range values {
		for _, v := range vs {
			pairs = append(pairs, kv{K: strings.ToLower(k), V: v})
		}
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].K != pairs[j].K {
			return pairs[i].K < pairs[j].K
		}
		return pairs[i].V < pairs[j].V
	})
	var b strings.Builder
	for i, p := range pairs {
		if i > 0 {
			b.WriteByte('&')
		}
		b.WriteString(rfcEncode(p.K))
		b.WriteByte('=')
		b.WriteString(rfcEncode(p.V))
	}
	return b.String()
}

func rfcEncode(s string) string {
	enc := url.QueryEscape(s)
	enc = strings.ReplaceAll(enc, "+", "%20")
	// QueryEscape leaves these unencoded; RFC 3986 strict requires encoding.
	enc = strings.ReplaceAll(enc, "!", "%21")
	enc = strings.ReplaceAll(enc, "'", "%27")
	enc = strings.ReplaceAll(enc, "(", "%28")
	enc = strings.ReplaceAll(enc, ")", "%29")
	enc = strings.ReplaceAll(enc, "*", "%2A")
	return enc
}

func abs64(x int64) int64 {
	if x < 0 {
		return -x
	}
	return x
}
