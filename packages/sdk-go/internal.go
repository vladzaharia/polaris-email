package polarissdk

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
)

func sha256SumOrEmpty(b []byte) [32]byte {
	return sha256.Sum256(b)
}

func hmacHex(secret, payload []byte) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write(payload)
	return hex.EncodeToString(mac.Sum(nil))
}
