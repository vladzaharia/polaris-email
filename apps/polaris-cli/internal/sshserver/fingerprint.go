// SSH pubkey fingerprint helpers.
//
// The wire format matches `ssh-keygen -E sha256 -lf <pubkey>` exactly:
// "SHA256:" + standard base64 (alphabet A-Za-z0-9+/) of sha256(pk.Marshal()),
// stripped of '=' padding (43 chars total after the colon).
package sshserver

import (
	"crypto/sha256"
	"encoding/base64"

	"github.com/charmbracelet/ssh"
)

// FingerprintSHA256 produces the canonical SSH pubkey fingerprint.
func FingerprintSHA256(pk ssh.PublicKey) string {
	sum := sha256.Sum256(pk.Marshal())
	return "SHA256:" + base64.RawStdEncoding.EncodeToString(sum[:])
}
