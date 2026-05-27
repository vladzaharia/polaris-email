package mailtest

import (
	"crypto/tls"
	"errors"
	"net"
	"testing"
	"time"
)

// PeerCertSerial dials addr with TLS, completes the handshake, and
// returns the leaf cert's SerialNumber as a string. Useful for cert
// hot-reload tests (T3) — compare serials before/after a cert swap to
// confirm the listener served a new cert.
func PeerCertSerial(t *testing.T, addr string, cfg *tls.Config) (string, error) {
	t.Helper()
	dialer := &net.Dialer{Timeout: 3 * time.Second}
	c, err := tls.DialWithDialer(dialer, "tcp", addr, cfg)
	if err != nil {
		return "", err
	}
	defer c.Close()
	state := c.ConnectionState()
	if len(state.PeerCertificates) == 0 {
		return "", errors.New("mailtest: no peer certificates")
	}
	return state.PeerCertificates[0].SerialNumber.String(), nil
}
