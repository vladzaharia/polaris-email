package imap

import (
	"bufio"
	"context"
	"net"
	"strings"
	"testing"
	"time"

	polarissdk "github.com/polaris-email/polaris-sdk-go"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/push"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/store"
)

// pipeListener wraps a single net.Pipe pair so the server's accept loop
// receives exactly one connection.
type pipeListener struct {
	conn   net.Conn
	served bool
	closed chan struct{}
}

func (p *pipeListener) Accept() (net.Conn, error) {
	if p.served {
		<-p.closed
		return nil, net.ErrClosed
	}
	p.served = true
	return p.conn, nil
}

func (p *pipeListener) Close() error {
	select {
	case <-p.closed:
	default:
		close(p.closed)
	}
	return nil
}

func (p *pipeListener) Addr() net.Addr { return dummyAddr{} }

type dummyAddr struct{}

func (dummyAddr) Network() string { return "pipe" }
func (dummyAddr) String() string  { return "pipe" }

func newTestServer(t *testing.T) (*Server, net.Conn, func()) {
	t.Helper()
	mirror, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("mirror: %v", err)
	}
	// Seed a fake message so SELECT INBOX returns EXISTS=1.
	if err := mirror.UpsertMessageMeta(context.Background(), store.MessageMeta{
		ID: "msg-1", MailboxID: "mb-1", FromAddr: "a@example.com",
		Subject: "hi", BodyBytes: 10, CreatedAt: "2026-05-13T00:00:00Z",
	}); err != nil {
		t.Fatalf("upsert meta: %v", err)
	}
	if err := mirror.UpsertState(context.Background(), store.MailboxState{
		MailboxID: "mb-1", MessageID: "msg-1", UID: 1, UIDValidity: 1, ChangeID: 1, Flags: "[]",
	}); err != nil {
		t.Fatalf("upsert state: %v", err)
	}

	c1, c2 := net.Pipe()
	ln := &pipeListener{conn: c1, closed: make(chan struct{})}
	srv := New(Options{ListenAddr: "pipe"}, Deps{
		Client: func() *polarissdk.Client {
			c := polarissdk.NewClient("http://stub")
			c.BridgeID = "test-bridge"
			c.BridgeSecret = []byte("test-secret")
			return c
		}(),
		Mirror: mirror,
		Push:   push.New(),
	})
	ctx, cancel := context.WithCancel(context.Background())
	go func() { _ = srv.ServeListener(ctx, ln) }()
	cleanup := func() {
		cancel()
		_ = ln.Close()
		c2.Close()
		mirror.Close()
	}
	return srv, c2, cleanup
}

func TestIMAPGreeting(t *testing.T) {
	_, conn, cleanup := newTestServer(t)
	defer cleanup()
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	rd := bufio.NewReader(conn)
	line, err := rd.ReadString('\n')
	if err != nil {
		t.Fatalf("read greeting: %v", err)
	}
	if !strings.HasPrefix(line, "* OK polaris-mail-bridge") {
		t.Errorf("unexpected greeting: %q", line)
	}
}

func TestIMAPCapability(t *testing.T) {
	_, conn, cleanup := newTestServer(t)
	defer cleanup()
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	rd := bufio.NewReader(conn)
	_, _ = rd.ReadString('\n') // greeting
	if _, err := conn.Write([]byte("A001 CAPABILITY\r\n")); err != nil {
		t.Fatal(err)
	}
	gotUntagged := false
	gotOK := false
	for i := 0; i < 4 && !(gotUntagged && gotOK); i++ {
		l, err := rd.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(l, "* CAPABILITY IMAP4rev1 IMAP4rev2") {
			gotUntagged = true
		}
		if strings.HasPrefix(l, "A001 OK") {
			gotOK = true
		}
	}
	if !gotUntagged || !gotOK {
		t.Errorf("CAPABILITY incomplete (untagged=%v ok=%v)", gotUntagged, gotOK)
	}
}

func TestIMAPParseCommand(t *testing.T) {
	tag, cmd, args := parseCommand(`A001 LOGIN "alice" "secret"`)
	if tag != "A001" || cmd != "LOGIN" || len(args) != 2 || unquote(args[0]) != "alice" {
		t.Errorf("parse: tag=%q cmd=%q args=%v", tag, cmd, args)
	}
	tag, cmd, args = parseCommand("A002 FETCH 1:* (UID FLAGS BODYSTRUCTURE)")
	if cmd != "FETCH" || args[0] != "1:*" || args[1] != "(UID FLAGS BODYSTRUCTURE)" {
		t.Errorf("fetch parse: args=%v", args)
	}
}

func TestMergeFlags(t *testing.T) {
	got := mergeFlags("+FLAGS", []string{"\\Seen"}, []string{"\\Flagged"})
	if len(got) != 2 || !containsFlag(got, "\\Seen") || !containsFlag(got, "\\Flagged") {
		t.Errorf("+FLAGS merge: %v", got)
	}
	got = mergeFlags("-FLAGS", []string{"\\Seen", "\\Flagged"}, []string{"\\Seen"})
	if len(got) != 1 || got[0] != "\\Flagged" {
		t.Errorf("-FLAGS merge: %v", got)
	}
	got = mergeFlags("FLAGS", []string{"\\Seen"}, []string{"\\Deleted"})
	if len(got) != 1 || got[0] != "\\Deleted" {
		t.Errorf("FLAGS overwrite: %v", got)
	}
}
