package imap

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"time"
)

// session holds per-connection IMAP state.
type session struct {
	conn   net.Conn
	rd     *bufio.Reader
	wr     *bufio.Writer
	deps   Deps
	logger interface {
		Printf(string, ...any)
	}

	mu          sync.Mutex
	authState   string // unauthenticated | authenticated | selected | logout
	mailboxID   string // set after LOGIN
	username    string
	selectedRO  bool // EXAMINE vs SELECT
	idleActive  bool
	idleSinkID  string
	sessionTag  string
	deviceID    string
	lastMessage time.Time
}

func newSession(conn net.Conn, deps Deps) *session {
	return &session{
		conn:      conn,
		rd:        bufio.NewReader(conn),
		wr:        bufio.NewWriter(conn),
		deps:      deps,
		logger:    deps.Logger,
		authState: "unauthenticated",
		deviceID:  fmt.Sprintf("imap-%d", time.Now().UnixNano()),
	}
}

func (s *session) writeLine(line string) error {
	if _, err := s.wr.WriteString(line + "\r\n"); err != nil {
		return err
	}
	return s.wr.Flush()
}

// taggedOK / taggedBAD / taggedNO write the final response of a command.
func (s *session) taggedOK(tag, text string) error {
	return s.writeLine(fmt.Sprintf("%s OK %s", tag, text))
}
func (s *session) taggedBAD(tag, text string) error {
	return s.writeLine(fmt.Sprintf("%s BAD %s", tag, text))
}
func (s *session) taggedNO(tag, text string) error {
	return s.writeLine(fmt.Sprintf("%s NO %s", tag, text))
}

func (s *session) untagged(line string) error {
	return s.writeLine("* " + line)
}

// run drives a session from greeting to LOGOUT.
func (s *session) run(ctx context.Context) {
	defer s.conn.Close()
	if err := s.writeLine("* OK polaris-mail-bridge IMAP4rev2 ready"); err != nil {
		return
	}
	for {
		if ctx.Err() != nil {
			return
		}
		_ = s.conn.SetReadDeadline(time.Now().Add(30 * time.Minute))
		line, err := s.rd.ReadString('\n')
		if err != nil {
			if err != io.EOF {
				s.logger.Printf("imap: read: %v", err)
			}
			return
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			continue
		}
		tag, cmd, args := parseCommand(line)
		if tag == "" {
			_ = s.writeLine("* BAD unparseable command")
			continue
		}
		if err := s.dispatch(ctx, tag, cmd, args); err != nil {
			s.logger.Printf("imap: dispatch %s: %v", cmd, err)
			return
		}
		if s.authState == "logout" {
			return
		}
	}
}
