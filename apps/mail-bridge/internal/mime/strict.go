// Package mime is a Go port of packages/mime/src/canonicalize.ts.
//
// Strict RFC 5322 / RFC 2822 MIME canonicalizer (C2 mitigation).
// Rejects bare LF, NUL bytes, oversized header lines, duplicate singleton
// headers, and forbidden submitter headers. Re-serializes to canonical CRLF.
package mime

import (
	"bytes"
	"fmt"
	"strings"
)

const (
	MaxHeaderLine       = 998 // RFC 5322 §2.1.1
	MaxHeaders          = 256
	MaxTotalHeaderBytes = 64 * 1024
)

var singletonHeaders = map[string]struct{}{
	"date": {}, "from": {}, "sender": {}, "reply-to": {}, "to": {}, "cc": {},
	"bcc": {}, "message-id": {}, "in-reply-to": {}, "references": {},
	"subject": {}, "return-path": {}, "mime-version": {},
	"content-type": {}, "content-transfer-encoding": {},
}

var forbiddenHeaders = map[string]struct{}{
	"received": {}, "return-path": {}, "dkim-signature": {},
	"authentication-results": {}, "arc-seal": {},
	"arc-message-signature": {}, "arc-authentication-results": {},
	"resent-date": {}, "resent-from": {}, "resent-sender": {},
	"resent-to": {}, "resent-cc": {}, "resent-bcc": {},
	"resent-message-id": {},
}

// Header is a single parsed header.
type Header struct {
	NameLc string // lowercased name
	Name   string // display-cased name from input
	Value  string // unfolded value with leading whitespace stripped
}

// ParsedMime is the result of ParseStrict.
type ParsedMime struct {
	Headers []Header
	Body    []byte
}

// MimeError carries a stable code for upstream mapping.
type MimeError struct {
	Msg  string
	Code string
}

func (e *MimeError) Error() string { return e.Msg }

func newErr(code, msg string) *MimeError { return &MimeError{Msg: msg, Code: code} }

// ParseStrict parses and validates input. Returns *MimeError on policy failure.
func ParseStrict(input []byte) (*ParsedMime, error) {
	crlfBoundary := -1
	for i := 0; i < len(input); i++ {
		b := input[i]
		if b == 0 {
			return nil, newErr("nul_byte", "NUL byte in message")
		}
		if b == 0x0d {
			if i+1 >= len(input) || input[i+1] != 0x0a {
				return nil, newErr("bare_cr", "bare CR in message")
			}
			i++ // consume LF
			if i+2 < len(input) && input[i+1] == 0x0d && input[i+2] == 0x0a {
				crlfBoundary = i + 1
				break
			}
		} else if b == 0x0a {
			return nil, newErr("bare_lf", "bare LF in header section")
		}
	}
	if crlfBoundary == -1 {
		return nil, newErr("no_boundary", "no header/body boundary (CRLF CRLF) found")
	}

	headerBytes := input[:crlfBoundary]
	if len(headerBytes) > MaxTotalHeaderBytes {
		return nil, newErr("headers_too_large",
			fmt.Sprintf("headers exceed %d bytes", MaxTotalHeaderBytes))
	}

	headers, err := parseHeaders(headerBytes)
	if err != nil {
		return nil, err
	}
	if err := enforceHeaderPolicy(headers); err != nil {
		return nil, err
	}

	bodyStart := crlfBoundary + 2
	// Defensive bounds check (Phase 4b.9). The detection loop above
	// guarantees crlfBoundary <= len(input)-2 (we only assign it when
	// `i+2 < len(input)`), so bodyStart <= len(input). But a future
	// refactor that loosens that invariant could let bodyStart exceed
	// len(input) and panic in the slice expression below. The explicit
	// check turns that into a clean "no_boundary" rejection.
	if bodyStart > len(input) {
		return nil, newErr("no_boundary", "no header/body boundary (CRLF CRLF) found")
	}
	body := make([]byte, len(input)-bodyStart)
	copy(body, input[bodyStart:])
	for _, b := range body {
		if b == 0 {
			return nil, newErr("nul_byte", "NUL byte in message")
		}
	}

	return &ParsedMime{Headers: headers, Body: body}, nil
}

func parseHeaders(b []byte) ([]Header, error) {
	s := string(b)
	lines := strings.Split(s, "\r\n")
	var headers []Header
	var curName, curValue string
	have := false

	flush := func() {
		if have {
			headers = append(headers, Header{
				NameLc: strings.ToLower(curName),
				Name:   curName,
				Value:  curValue,
			})
		}
	}

	for _, line := range lines {
		if line == "" {
			continue
		}
		if len(line) > MaxHeaderLine {
			return nil, newErr("header_too_long",
				fmt.Sprintf("header line exceeds %d octets", MaxHeaderLine))
		}
		isCont := line[0] == ' ' || line[0] == '\t'
		if isCont {
			if !have {
				return nil, newErr("orphan_continuation", "continuation before any header")
			}
			curValue += " " + strings.TrimSpace(line)
			continue
		}
		flush()
		colon := strings.IndexByte(line, ':')
		if colon <= 0 {
			snippet := line
			if len(snippet) > 40 {
				snippet = snippet[:40]
			}
			return nil, newErr("malformed_header", "malformed header line: "+snippet)
		}
		name := strings.TrimSpace(line[:colon])
		val := strings.TrimSpace(line[colon+1:])
		if !validHeaderName(name) {
			return nil, newErr("invalid_header_name", "header name has invalid bytes: "+name)
		}
		curName, curValue, have = name, val, true
		if len(headers)+1 > MaxHeaders {
			return nil, newErr("too_many_headers",
				fmt.Sprintf("exceeded %d headers", MaxHeaders))
		}
	}
	flush()
	return headers, nil
}

func validHeaderName(s string) bool {
	if len(s) == 0 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c < 0x21 || c > 0x7e {
			return false
		}
	}
	return true
}

func enforceHeaderPolicy(headers []Header) error {
	seen := make(map[string]struct{})
	for _, h := range headers {
		if _, ok := forbiddenHeaders[h.NameLc]; ok {
			return newErr("forbidden_header", "forbidden submitter header: "+h.Name)
		}
		if _, ok := singletonHeaders[h.NameLc]; ok {
			if _, dup := seen[h.NameLc]; dup {
				return newErr("duplicate_singleton", "duplicate singleton header: "+h.Name)
			}
			seen[h.NameLc] = struct{}{}
		}
	}
	return nil
}

// Serialize re-serializes parsed MIME as canonical CRLF bytes.
func Serialize(p *ParsedMime) []byte {
	var buf bytes.Buffer
	for _, h := range p.Headers {
		buf.WriteString(h.Name)
		buf.WriteString(": ")
		buf.WriteString(h.Value)
		buf.WriteString("\r\n")
	}
	buf.WriteString("\r\n")
	buf.Write(p.Body)
	return buf.Bytes()
}

// GetHeader returns the value of the first header matching nameLc, or "".
func GetHeader(p *ParsedMime, nameLc string) string {
	for _, h := range p.Headers {
		if h.NameLc == nameLc {
			return h.Value
		}
	}
	return ""
}

// SetHeader replaces or inserts a header.
func SetHeader(p *ParsedMime, name, value string) {
	nameLc := strings.ToLower(name)
	for i := range p.Headers {
		if p.Headers[i].NameLc == nameLc {
			p.Headers[i].Name = name
			p.Headers[i].Value = value
			return
		}
	}
	p.Headers = append([]Header{{NameLc: nameLc, Name: name, Value: value}}, p.Headers...)
}
