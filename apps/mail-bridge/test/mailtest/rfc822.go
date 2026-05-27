package mailtest

import (
	"bytes"
	"embed"
	"fmt"
	"strings"
	"testing"
)

//go:embed testdata/*.eml
var testdataFS embed.FS

// LoadEML reads the named .eml from the package's embedded testdata.
// Always returns CRLF-terminated bytes — the bridge's strict MIME
// parser expects RFC822 line endings.
func LoadEML(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := testdataFS.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatalf("mailtest: load %q: %v", name, err)
	}
	return toCRLF(raw)
}

// LargeMessage builds a synthetic RFC822 message of approximately
// targetSize bytes. Useful for size-cap tests (SM5).
func LargeMessage(targetSize int) []byte {
	header := "From: alice@example.com\r\n" +
		"To: bob@inbound.test\r\n" +
		"Subject: large-message\r\n" +
		"Date: Mon, 26 May 2026 12:03:00 +0000\r\n" +
		"Message-ID: <large-mailtest@example.com>\r\n" +
		"MIME-Version: 1.0\r\n" +
		"Content-Type: text/plain; charset=utf-8\r\n\r\n"
	if targetSize <= len(header) {
		return []byte(header)
	}
	pad := targetSize - len(header)
	var buf bytes.Buffer
	buf.WriteString(header)
	// Fill body with 'A' lines so the result is roughly the requested
	// size.
	const lineLen = 78
	for buf.Len() < targetSize {
		remaining := pad - (buf.Len() - len(header))
		if remaining <= 0 {
			break
		}
		n := min(lineLen, remaining)
		buf.WriteString(strings.Repeat("A", n))
		buf.WriteString("\r\n")
	}
	return buf.Bytes()
}

// EMLWithMessageID returns an RFC822 message with a unique message-id —
// handy for SMTP submissions where the test wants to assert dedup
// behavior on a controlled idempotency key.
func EMLWithMessageID(messageID string) []byte {
	body := fmt.Sprintf(
		"From: alice@example.com\r\n"+
			"To: bob@inbound.test\r\n"+
			"Subject: mailtest-%s\r\n"+
			"Date: Mon, 26 May 2026 12:00:00 +0000\r\n"+
			"Message-ID: <%s>\r\n"+
			"MIME-Version: 1.0\r\n"+
			"Content-Type: text/plain; charset=utf-8\r\n\r\n"+
			"Synthetic body for %s.\r\n",
		messageID, messageID, messageID,
	)
	return []byte(body)
}

func toCRLF(in []byte) []byte {
	// Idempotent: normalize CR/LF to CR-LF only if not already present.
	if bytes.Contains(in, []byte("\r\n")) {
		return in
	}
	return bytes.ReplaceAll(in, []byte("\n"), []byte("\r\n"))
}
