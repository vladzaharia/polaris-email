// Package sign computes the polaris-email HMAC signature for an outbound
// API request and sets the X-Polaris-{HMAC,Timestamp,Nonce} headers.
package sign

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"strconv"
	"time"
)

// Request signs req with the given HMAC key. The canonical string is
//
//	<METHOD>\n<path>\n<sha256-hex(body)>\n<unix-ts>\n<nonce-hex>
//
// where path includes the query string (e.g. "/v1/daemon/credentials?since=42").
func Request(req *http.Request, method, path string, body, key []byte) {
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	nonceBytes := make([]byte, 16)
	_, _ = rand.Read(nonceBytes)
	nonce := hex.EncodeToString(nonceBytes)
	bodyHash := sha256.Sum256(body)
	bodyHex := hex.EncodeToString(bodyHash[:])
	canonical := fmt.Sprintf("%s\n%s\n%s\n%s\n%s", method, path, bodyHex, ts, nonce)
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(canonical))
	req.Header.Set("X-Polaris-HMAC", hex.EncodeToString(mac.Sum(nil)))
	req.Header.Set("X-Polaris-Timestamp", ts)
	req.Header.Set("X-Polaris-Nonce", nonce)
}
