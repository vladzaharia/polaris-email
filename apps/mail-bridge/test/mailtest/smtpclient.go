package mailtest

import (
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"testing"
	"time"

	"github.com/emersion/go-sasl"
	"github.com/emersion/go-smtp"
)

// SMTPClient is a thin wrapper around go-smtp.Client that handles TLS
// dial + AUTH PLAIN in one call.
type SMTPClient struct {
	*smtp.Client
}

// DialSMTPSOpts controls DialSMTPS behavior.
type DialSMTPSOpts struct {
	// TLSConfig is required for implicit-TLS dial; pass nil to dial plaintext.
	TLSConfig *tls.Config
	// Timeout for connect/handshake.
	Timeout time.Duration
}

// DialSMTPS dials addr with implicit TLS using the supplied config.
// Pass nil TLSConfig to dial plaintext (for the plaintext-fallback
// scenarios).
func DialSMTPS(t *testing.T, addr string, opts DialSMTPSOpts) *SMTPClient {
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
		t.Fatalf("mailtest: dial smtps %s: %v", addr, err)
	}
	c := smtp.NewClient(conn)
	return &SMTPClient{Client: c}
}

// AuthPlain runs AUTH PLAIN with the given credentials.
func (c *SMTPClient) AuthPlain(username, password string) error {
	auth := sasl.NewPlainClient("", username, password)
	return c.Auth(auth)
}

// SendRFC822 runs MAIL FROM / RCPT TO / DATA with the given envelope
// addresses and raw RFC822 body. Returns the SMTP server error verbatim.
func (c *SMTPClient) SendRFC822(from string, rcpts []string, body []byte) error {
	if err := c.Mail(from, nil); err != nil {
		return fmt.Errorf("MAIL FROM: %w", err)
	}
	for _, r := range rcpts {
		if err := c.Rcpt(r, nil); err != nil {
			return fmt.Errorf("RCPT TO %s: %w", r, err)
		}
	}
	w, err := c.Data()
	if err != nil {
		return fmt.Errorf("DATA: %w", err)
	}
	if _, err := io.Copy(w, byteReader(body)); err != nil {
		_ = w.Close()
		return fmt.Errorf("DATA write: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("DATA close: %w", err)
	}
	return nil
}

// Quit closes the SMTP session.
func (c *SMTPClient) QuitOrClose() {
	if err := c.Quit(); err != nil {
		_ = c.Close()
	}
}

// MustClose is a t.Cleanup helper.
func (c *SMTPClient) MustClose(t *testing.T) {
	t.Helper()
	c.QuitOrClose()
}

// byteReader avoids pulling bytes.NewReader into the public API.
func byteReader(b []byte) io.Reader { return &sliceReader{b: b} }

type sliceReader struct {
	b []byte
	i int
}

func (s *sliceReader) Read(p []byte) (int, error) {
	if s.i >= len(s.b) {
		return 0, io.EOF
	}
	n := copy(p, s.b[s.i:])
	s.i += n
	return n, nil
}

// PeerCert returns the leaf cert from the TLS handshake of an SMTPS
// connection. Useful for T3 (cert hot-reload assertion).
func PeerCert(c *SMTPClient) ([]byte, error) {
	// go-smtp doesn't surface the conn directly. Tests that need this
	// should use net/tls.Dial themselves to peek at the cert; returning
	// an error keeps the API honest.
	return nil, errors.New("mailtest: PeerCert not implemented; dial via crypto/tls directly to inspect peer cert")
}
