package push

import (
	"bufio"
	"fmt"
	"sync"
)

// IMAPIdleSink delivers `* n EXISTS` style untagged responses to an IMAP
// client currently in the IDLE state.
type IMAPIdleSink struct {
	mu     sync.Mutex
	id     string
	writer *bufio.Writer
	// ExistsFn supplies the current EXISTS count for the mailbox. The push
	// manager only knows that *something* changed; the IDLE protocol needs
	// the actual count, so we let the caller plug in a fresh-state lookup.
	ExistsFn func() int
}

// NewIMAPIdleSink constructs a sink wrapping the buffered writer for the
// IDLE conn.
func NewIMAPIdleSink(id string, w *bufio.Writer, exists func() int) *IMAPIdleSink {
	return &IMAPIdleSink{id: id, writer: w, ExistsFn: exists}
}

// ID implements Sink.
func (s *IMAPIdleSink) ID() string { return s.id }

// Deliver implements Sink.
func (s *IMAPIdleSink) Deliver(_ StateChange) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	if s.ExistsFn != nil {
		n = s.ExistsFn()
	}
	// Untagged EXISTS response per RFC 9051.
	if _, err := fmt.Fprintf(s.writer, "* %d EXISTS\r\n", n); err != nil {
		return err
	}
	return s.writer.Flush()
}
