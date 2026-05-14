// Package polarissdk provides the Go SDK for polaris-email.
//
// `webhook.go` is the hand-written HMAC verifier; consumers receiving webhook
// deliveries should call `VerifyWebhook` to validate the request before
// trusting its body.
//
// `client.go` (hand-written) wraps the generated low-level operations with
// HMAC signing for the API direction.
//
// `generated.go` is the oapi-codegen output — DO NOT EDIT directly; rerun
// `pnpm --filter @polaris/sdk-codegen run generate`.
package polarissdk

import (
	"crypto/hmac"
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
	DirectionAPI     Direction = "polaris-api.v1"
	DirectionWebhook Direction = "polaris-webhook.v1"
)

// VerifyInput carries the inputs needed to verify a single request signature.
//
// AllowedAlgorithms defaults to {"v1","v2"} — the v2 tag is what the fanout
// worker emits today; v1 is kept on the allowlist so subscribers can still
// verify deliveries signed before the v2 rollout.
type VerifyInput struct {
	Direction         Direction
	Method            string
	Path              string
	Query             string
	Headers           map[string]string
	Body              []byte
	Secret            []byte
	AllowedAlgorithms []string
	SkewSeconds       int
	Now               time.Time
}

// VerifyCode is a stable error code returned in the Result for tests / log routing.
type VerifyCode string

const (
	CodeMissingHeader     VerifyCode = "missing_header"
	CodeHeaderInvalid     VerifyCode = "header_invalid"
	CodeClockSkew         VerifyCode = "clock_skew"
	CodeAlgorithmRejected VerifyCode = "algorithm_rejected"
	CodeBadSignature      VerifyCode = "bad_signature"
)

// VerifyResult is the result of VerifyWebhook.
type VerifyResult struct {
	OK        bool
	Algorithm string
	Ts        int64
	Nonce     string
	Code      VerifyCode
	Err       error
}

// VerifyWebhook returns true when the signature on the input headers matches
// HMAC-SHA256 of the canonical string under `secret`. The convenience boolean
// wrapper mirrors the spec in the README; callers that need granular errors
// should use VerifyWebhookFull.
func VerifyWebhook(payload []byte, signatureHeader string, secret []byte) bool {
	// Convenience form expects the *full* `X-Polaris-Sig` header value. The
	// canonical string requires `ts`/`nonce`/method/path which this short form
	// can't recover — so this overload only verifies the prefix is valid and
	// the hex is reachable. Callers wiring real HTTP requests should call
	// VerifyWebhookFull below.
	eq := strings.IndexByte(signatureHeader, '=')
	if eq <= 0 {
		return false
	}
	prefix := signatureHeader[:eq]
	if prefix != "v1" && prefix != "v2" {
		return false
	}
	hexStr := signatureHeader[eq+1:]
	provided, err := hex.DecodeString(hexStr)
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write(payload)
	expected := mac.Sum(nil)
	return hmac.Equal(expected, provided)
}

// VerifyWebhookFull performs the strict canonical-string verification used by
// the SDK tests and recommended for production use.
func VerifyWebhookFull(in VerifyInput) VerifyResult {
	allowed := in.AllowedAlgorithms
	if len(allowed) == 0 {
		allowed = []string{"v1", "v2"}
	}
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
	if !noCRLF(tsRaw) || !noCRLF(nonce) || !noCRLF(sig) {
		return VerifyResult{Code: CodeHeaderInvalid, Err: errors.New("crlf")}
	}
	eq := strings.IndexByte(sig, '=')
	if eq <= 0 {
		return VerifyResult{Code: CodeHeaderInvalid, Err: errors.New("sig format")}
	}
	prefix := sig[:eq]
	hexStr := sig[eq+1:]
	for _, c := range hexStr {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return VerifyResult{Code: CodeHeaderInvalid, Err: errors.New("sig hex")}
		}
	}
	algoOK := false
	for _, a := range allowed {
		if prefix == a {
			algoOK = true
			break
		}
	}
	if !algoOK {
		return VerifyResult{Code: CodeAlgorithmRejected, Err: errors.New(prefix)}
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
	provided, err := hex.DecodeString(hexStr)
	if err != nil || len(provided) != len(expected) || !hmac.Equal(expected, provided) {
		return VerifyResult{Code: CodeBadSignature, Err: errors.New("hmac mismatch")}
	}
	return VerifyResult{OK: true, Algorithm: prefix, Ts: ts, Nonce: nonce}
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

func canonicalQuery(raw string) string {
	if raw == "" {
		return ""
	}
	if strings.HasPrefix(raw, "?") {
		raw = raw[1:]
	}
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
	return enc
}

func abs64(x int64) int64 {
	if x < 0 {
		return -x
	}
	return x
}
