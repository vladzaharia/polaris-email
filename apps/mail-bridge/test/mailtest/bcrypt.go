package mailtest

import "golang.org/x/crypto/bcrypt"

// bcryptHash returns the bcrypt hash of plaintext at the given cost.
// Tests use cost 4 (fast); production uses cost 12.
func bcryptHash(plaintext string, cost int) (string, error) {
	if cost <= 0 {
		cost = 4
	}
	h, err := bcrypt.GenerateFromPassword([]byte(plaintext), cost)
	if err != nil {
		return "", err
	}
	return string(h), nil
}
