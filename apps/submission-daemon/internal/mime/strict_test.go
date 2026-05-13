package mime

import (
	"bytes"
	"strings"
	"testing"
)

func TestParseStrict_ValidRoundTrip(t *testing.T) {
	in := []byte("From: a@b\r\nTo: c@d\r\nSubject: hi\r\n\r\nbody\r\nline2\r\n")
	p, err := ParseStrict(in)
	if err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	if len(p.Headers) != 3 {
		t.Fatalf("want 3 headers, got %d", len(p.Headers))
	}
	if !bytes.Equal(p.Body, []byte("body\r\nline2\r\n")) {
		t.Fatalf("body mismatch: %q", p.Body)
	}
	out := Serialize(p)
	if !bytes.Equal(in, out) {
		t.Fatalf("round-trip mismatch:\nin=%q\nout=%q", in, out)
	}
}

func TestParseStrict_GetHeader(t *testing.T) {
	in := []byte("From: a@b\r\nSubject: Hello\r\n\r\n")
	p, err := ParseStrict(in)
	if err != nil {
		t.Fatal(err)
	}
	if GetHeader(p, "subject") != "Hello" {
		t.Fatal("get subject")
	}
	if GetHeader(p, "missing") != "" {
		t.Fatal("missing should be empty")
	}
}

func TestParseStrict_Rejections(t *testing.T) {
	cases := []struct {
		name string
		in   []byte
		code string
	}{
		{"bare LF", []byte("From: a@b\nTo: c@d\r\n\r\n"), "bare_lf"},
		{"NUL byte", []byte("From: a@b\r\n\r\nbo\x00dy"), "nul_byte"},
		{"oversized header", []byte("X-Big: " + strings.Repeat("x", 1000) + "\r\n\r\n"), "header_too_long"},
		{"dup From", []byte("From: a@b\r\nFrom: c@d\r\n\r\n"), "duplicate_singleton"},
		{"dup Date", []byte("Date: x\r\nDate: y\r\n\r\n"), "duplicate_singleton"},
		{"forbidden Received", []byte("Received: from x\r\n\r\n"), "forbidden_header"},
		{"forbidden DKIM-Signature", []byte("DKIM-Signature: v=1\r\n\r\n"), "forbidden_header"},
		{"forbidden Resent-From", []byte("Resent-From: x@y\r\n\r\n"), "forbidden_header"},
		{"forbidden ARC-Seal", []byte("ARC-Seal: x\r\n\r\n"), "forbidden_header"},
		{"no boundary", []byte("From: a@b\r\n"), "no_boundary"},
		{"bare CR", []byte("From: a@b\r\rTo: c\r\n\r\n"), "bare_cr"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := ParseStrict(c.in)
			if err == nil {
				t.Fatalf("want error %s, got nil", c.code)
			}
			me, ok := err.(*MimeError)
			if !ok {
				t.Fatalf("want *MimeError, got %T: %v", err, err)
			}
			if me.Code != c.code {
				t.Fatalf("want code %q got %q (msg=%s)", c.code, me.Code, me.Msg)
			}
		})
	}
}

func TestParseStrict_BodyBytePreservation(t *testing.T) {
	body := []byte{0x01, 0x02, 0x03, 'X', 'Y', '\r', '\n', 'Z'}
	in := append([]byte("From: a@b\r\n\r\n"), body...)
	p, err := ParseStrict(in)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(p.Body, body) {
		t.Fatalf("body bytes mutated: %v vs %v", p.Body, body)
	}
}

func TestParseStrict_HeaderContinuation(t *testing.T) {
	in := []byte("Subject: hello\r\n world\r\nFrom: a@b\r\n\r\n")
	p, err := ParseStrict(in)
	if err != nil {
		t.Fatal(err)
	}
	if GetHeader(p, "subject") != "hello world" {
		t.Fatalf("want unfold, got %q", GetHeader(p, "subject"))
	}
}

func TestSetHeader(t *testing.T) {
	in := []byte("From: a@b\r\n\r\n")
	p, err := ParseStrict(in)
	if err != nil {
		t.Fatal(err)
	}
	SetHeader(p, "Return-Path", "<x@y>")
	if GetHeader(p, "return-path") != "<x@y>" {
		t.Fatal("set new header")
	}
	SetHeader(p, "From", "z@w")
	if GetHeader(p, "from") != "z@w" {
		t.Fatal("replace existing")
	}
}
