package mailtest

import (
	"crypto/tls"
	"net"
	"testing"
	"time"

	"github.com/emersion/go-imap/v2/imapclient"
)

// IMAPClient is a thin wrapper around go-imap/v2/imapclient that
// handles TLS dial + LOGIN in one call.
type IMAPClient struct {
	*imapclient.Client
}

// DialIMAPSOpts mirrors DialSMTPSOpts.
type DialIMAPSOpts struct {
	TLSConfig *tls.Config
	Timeout   time.Duration
}

// DialIMAPS dials addr with implicit TLS using the supplied config.
func DialIMAPS(t *testing.T, addr string, opts DialIMAPSOpts) *IMAPClient {
	return DialIMAPSWithOptions(t, addr, opts, nil)
}

// DialIMAPSWithOptions is the DialIMAPS variant that lets the caller
// pass through imapclient.Options (e.g. UnilateralDataHandler for IDLE
// tests).
func DialIMAPSWithOptions(t *testing.T, addr string, opts DialIMAPSOpts, clientOpts *imapclient.Options) *IMAPClient {
	t.Helper()
	timeout := opts.Timeout
	if timeout == 0 {
		timeout = 5 * time.Second
	}
	dialer := &net.Dialer{Timeout: timeout}
	var conn net.Conn
	var err error
	if opts.TLSConfig != nil {
		conn, err = tls.DialWithDialer(dialer, "tcp", addr, opts.TLSConfig)
	} else {
		conn, err = dialer.Dial("tcp", addr)
	}
	if err != nil {
		t.Fatalf("mailtest: dial imaps %s: %v", addr, err)
	}
	c := imapclient.New(conn, clientOpts)
	return &IMAPClient{Client: c}
}

// MustClose tears down the IMAP session.
//
// Logout grabs the client write mutex, which deadlocks if the test
// abandons the connection mid-IDLE (the IDLE goroutine never released
// the lock). The transport Close() unblocks the IDLE reader; we always
// reach it via the deferred call, so a stuck Logout caps the wait at
// 2 seconds instead of pinning CI to the test framework's full timeout.
func (c *IMAPClient) MustClose(t *testing.T) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		_ = c.Logout().Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
	}
	_ = c.Close()
}
