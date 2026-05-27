package mailtest

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

// AssertReceivedMessageSubject fails the test if no submission with the
// given Subject header has arrived for `b` within the test's existing
// deadline (defaults to 5s).
func AssertReceivedMessageSubject(t *testing.T, f *FakeServer, b Bridge, subject string) SubmittedMessage {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		for _, s := range f.SubmissionsFor(b) {
			if subjectMatches(s.Body, subject) {
				return s
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("mailtest: no submission with Subject=%q observed for bridge %s", subject, b.ID)
	return SubmittedMessage{}
}

// AssertDirectiveAcked fails if the bridge hasn't ack'd the directive
// before the deadline (5s).
func AssertDirectiveAcked(t *testing.T, f *FakeServer, b Bridge, id DirectiveID) DirectiveAck {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		f.state.mu.Lock()
		br, ok := f.state.bridges[b.ID]
		if ok {
			if ack, acked := br.acked[string(id)]; acked {
				f.state.mu.Unlock()
				return ack
			}
		}
		f.state.mu.Unlock()
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("mailtest: directive %s never acked", id)
	return DirectiveAck{}
}

// AssertLogContains scans the recent heartbeats' log delta for `needle`.
// Returns the first matching log line.
func AssertLogContains(t *testing.T, f *FakeServer, b Bridge, needle string) string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		f.state.mu.Lock()
		br, ok := f.state.bridges[b.ID]
		if ok {
			for _, hb := range br.heartbeats {
				for _, line := range hb.Request.Logs {
					if strings.Contains(line.Msg, needle) {
						f.state.mu.Unlock()
						return line.Msg
					}
				}
			}
		}
		f.state.mu.Unlock()
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("mailtest: no log line containing %q observed for bridge %s", needle, b.ID)
	return ""
}

// subjectMatches scans the raw RFC822 body for a header value match
// (case-insensitive header name, trimmed value compare).
func subjectMatches(body []byte, want string) bool {
	for _, line := range bytes.Split(body, []byte("\r\n")) {
		if len(line) == 0 {
			return false // end of headers; not found
		}
		if !bytes.HasPrefix(bytes.ToLower(line), []byte("subject:")) {
			continue
		}
		v := bytes.TrimSpace(line[len("Subject:"):])
		if string(v) == want {
			return true
		}
	}
	return false
}
