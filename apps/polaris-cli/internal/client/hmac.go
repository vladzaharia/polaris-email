// Package client implements the HMAC signing scheme defined in
// packages/hmac/src/index.ts of the polaris-email monorepo.
//
// Canonical string (newline-joined, no trailing newline):
//
//	<direction>\n
//	<METHOD>\n
//	<path>\n
//	<canonical-query>\n
//	<X-Polaris-Ts>\n
//	<X-Polaris-Nonce>\n
//	<lowercase-hex(SHA-256(raw-body-bytes))>
//
// Signature header: X-Polaris-Sig: v1=<lowercase-hex(HMAC-SHA256(secret, canonical))>
package client

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"
)

// Direction is the HMAC domain-separation tag.
type Direction string

const (
	DirectionAPI     Direction = "polaris-api.v1"
	DirectionWebhook Direction = "polaris-webhook.v1"
)

// CanonicalInput holds everything needed to build the canonical signing string.
type CanonicalInput struct {
	Direction Direction
	Method    string
	Path      string
	Query     string // raw query string (without leading "?") — already canonicalized or to be canonicalized
	TS        string // unix milliseconds as decimal string
	Nonce     string
	Body      []byte
}

// CanonicalQuery sorts query parameters by lowercase key, then value, and
// percent-encodes per RFC 3986 to match the TypeScript implementation.
//
// Empty input returns "".
func CanonicalQuery(raw string) string {
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
		// Fall back to raw — the canonical builder will still produce *something*;
		// downstream verify will mismatch, surfacing the malformed input.
		return raw
	}
	type kv struct{ k, v string }
	var pairs []kv
	for k, vs := range values {
		for _, v := range vs {
			pairs = append(pairs, kv{k: k, v: v})
		}
	}
	sort.SliceStable(pairs, func(i, j int) bool {
		ki, kj := strings.ToLower(pairs[i].k), strings.ToLower(pairs[j].k)
		if ki != kj {
			return ki < kj
		}
		return pairs[i].v < pairs[j].v
	})
	var sb strings.Builder
	for i, p := range pairs {
		if i > 0 {
			sb.WriteByte('&')
		}
		sb.WriteString(rfc3986Encode(strings.ToLower(p.k)))
		sb.WriteByte('=')
		sb.WriteString(rfc3986Encode(p.v))
	}
	return sb.String()
}

// rfc3986Encode percent-encodes per RFC 3986 (encodeURIComponent + ! ' ( ) *).
func rfc3986Encode(s string) string {
	out := url.QueryEscape(s)
	// QueryEscape encodes space as '+'; RFC 3986 / encodeURIComponent uses %20.
	out = strings.ReplaceAll(out, "+", "%20")
	// QueryEscape leaves these unencoded; RFC 3986 strict requires encoding.
	replacer := strings.NewReplacer(
		"!", "%21",
		"'", "%27",
		"(", "%28",
		")", "%29",
		"*", "%2A",
	)
	return replacer.Replace(out)
}

// AssertNoCrlf rejects strings containing whitespace, control characters, or
// non-ASCII bytes — matching the TS implementation's strict header guard.
func AssertNoCrlf(name, value string) error {
	if value == "" {
		return fmt.Errorf("hmac: %s empty", name)
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		if c == 0x0a || c == 0x0d || c == 0x00 || c == 0x09 || c == 0x20 {
			return fmt.Errorf("hmac: %s contains whitespace or control character", name)
		}
		if c > 0x7e {
			return fmt.Errorf("hmac: %s non-ASCII", name)
		}
	}
	return nil
}

// BuildCanonical constructs the canonical string per the spec.
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
			return "", fmt.Errorf("hmac: invalid HTTP method")
		}
	}
	if !strings.HasPrefix(in.Path, "/") {
		return "", fmt.Errorf("hmac: path must start with /")
	}
	q := CanonicalQuery(in.Query)
	bodyHash := sha256.Sum256(in.Body)
	return strings.Join([]string{
		string(in.Direction),
		method,
		in.Path,
		q,
		in.TS,
		in.Nonce,
		hex.EncodeToString(bodyHash[:]),
	}, "\n"), nil
}

// Sign returns "v1=<hex>" for the given input + secret.
func Sign(in CanonicalInput, secret []byte) (string, error) {
	canon, err := BuildCanonical(in)
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(canon))
	return "v1=" + hex.EncodeToString(mac.Sum(nil)), nil
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
	return fmt.Sprintf("%d", time.Now().UnixMilli())
}
