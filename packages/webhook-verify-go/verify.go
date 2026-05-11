// Package polariswebhook verifies polaris-email HMAC signatures (inbound API + outbound webhooks).
package polariswebhook

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

type Direction string

const (
	API     Direction = "polaris-api.v1"
	Webhook Direction = "polaris-webhook.v1"
)

type Input struct {
	Direction         Direction
	Method            string
	Path              string
	Query             string // raw query, with or without leading '?'
	Headers           map[string]string
	Body              []byte
	Secret            []byte
	AllowedAlgorithms []string // default ["v1"]
	SkewSeconds       int      // default 300
	Now               time.Time
}

type Code string

const (
	CodeMissingHeader     Code = "missing_header"
	CodeHeaderInvalid     Code = "header_invalid"
	CodeClockSkew         Code = "clock_skew"
	CodeAlgorithmRejected Code = "algorithm_rejected"
	CodeBadSignature      Code = "bad_signature"
)

type Result struct {
	OK        bool
	Algorithm string
	Ts        int64
	Nonce     string
	Code      Code
	Err       error
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
	type kv struct {
		K, V string
	}
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

// rfcEncode encodes per RFC3986 percent-encoding rules — matching Node's encodeURIComponent
// with the !'()* fix-up.
func rfcEncode(s string) string {
	enc := url.QueryEscape(s)
	enc = strings.ReplaceAll(enc, "+", "%20")
	enc = strings.ReplaceAll(enc, "%21", "%21") // identity
	enc = strings.ReplaceAll(enc, "%27", "%27")
	enc = strings.ReplaceAll(enc, "%28", "%28")
	enc = strings.ReplaceAll(enc, "%29", "%29")
	enc = strings.ReplaceAll(enc, "%2A", "%2A")
	return enc
}

func Verify(in Input) Result {
	allowed := in.AllowedAlgorithms
	if len(allowed) == 0 {
		allowed = []string{"v1"}
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
		return Result{Code: CodeMissingHeader, Err: errors.New("X-Polaris-Ts")}
	}
	nonce, ok := pickHeader(in.Headers, "x-polaris-nonce")
	if !ok {
		return Result{Code: CodeMissingHeader, Err: errors.New("X-Polaris-Nonce")}
	}
	sig, ok := pickHeader(in.Headers, "x-polaris-sig")
	if !ok {
		return Result{Code: CodeMissingHeader, Err: errors.New("X-Polaris-Sig")}
	}
	if !noCRLF(tsRaw) || !noCRLF(nonce) || !noCRLF(sig) {
		return Result{Code: CodeHeaderInvalid, Err: errors.New("crlf")}
	}
	eq := strings.IndexByte(sig, '=')
	if eq <= 0 {
		return Result{Code: CodeHeaderInvalid, Err: errors.New("sig format")}
	}
	prefix := sig[:eq]
	hexStr := sig[eq+1:]
	for _, c := range hexStr {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return Result{Code: CodeHeaderInvalid, Err: errors.New("sig hex")}
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
		return Result{Code: CodeAlgorithmRejected, Err: errors.New(prefix)}
	}
	ts, err := strconv.ParseInt(tsRaw, 10, 64)
	if err != nil {
		return Result{Code: CodeHeaderInvalid, Err: err}
	}
	nowMs := now.UnixMilli()
	if abs64(nowMs-ts) > int64(skewSec)*1000 {
		return Result{Code: CodeClockSkew, Err: errors.New("ts skew")}
	}
	if len(nonce) < 16 || len(nonce) > 128 {
		return Result{Code: CodeHeaderInvalid, Err: errors.New("nonce length")}
	}
	method := strings.ToUpper(in.Method)
	for _, c := range method {
		if c < 'A' || c > 'Z' {
			return Result{Code: CodeHeaderInvalid, Err: errors.New("method")}
		}
	}
	if !strings.HasPrefix(in.Path, "/") {
		return Result{Code: CodeHeaderInvalid, Err: errors.New("path")}
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
		return Result{Code: CodeBadSignature, Err: errors.New("hmac mismatch")}
	}
	return Result{OK: true, Algorithm: prefix, Ts: ts, Nonce: nonce}
}

func abs64(x int64) int64 {
	if x < 0 {
		return -x
	}
	return x
}
