package imap

import (
	"context"
	"errors"

	polarissdk "github.com/polaris-email/polaris-sdk-go"
	"golang.org/x/crypto/bcrypt"
)

// authenticate verifies an IMAP LOGIN against polaris mailbox_credentials.
// Returns the mailbox_id on success.
func authenticate(ctx context.Context, client *polarissdk.Client, username, password string) (string, error) {
	if username == "" || password == "" {
		return "", errors.New("missing credentials")
	}
	cred, err := client.LookupMailboxCredential(ctx, "imap", username)
	if err != nil {
		return "", err
	}
	if cred == nil {
		return "", errors.New("no such credential")
	}
	if cred.AuthType != "password" {
		return "", errors.New("credential is not password-auth")
	}
	if err := bcrypt.CompareHashAndPassword([]byte(cred.BcryptHash), []byte(password)); err != nil {
		return "", errors.New("invalid password")
	}
	return cred.MailboxID, nil
}
