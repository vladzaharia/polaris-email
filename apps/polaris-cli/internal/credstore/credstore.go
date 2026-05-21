// Package credstore stores polaris-mail operator bearer tokens in the OS
// keychain. Falls back to a passphrase-encrypted file when no native
// keychain is available (e.g. headless CI hosts).
//
// One entry per profile. The "service" is `polaris-mail` and the "key"
// is the profile name. The stored value is a JSON-encoded Credential.
package credstore

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/99designs/keyring"
)

// Credential is the stored profile entry.
type Credential struct {
	APIURL     string    `json:"api_url"`
	KeyID      string    `json:"key_id"`
	Secret     string    `json:"secret"`
	OperatorID string    `json:"operator_id,omitempty"`
	Email      string    `json:"email,omitempty"`
	Name       string    `json:"name,omitempty"`
	Role       string    `json:"role,omitempty"`
	StoredAt   time.Time `json:"stored_at"`
}

// Store is the abstraction the CLI depends on.
type Store interface {
	Save(profile string, cred Credential) error
	Load(profile string) (*Credential, error)
	Delete(profile string) error
	List() ([]string, error)
}

const serviceName = "polaris-mail"

type kr struct {
	ring keyring.Keyring
}

func (s *kr) Save(profile string, cred Credential) error {
	if profile == "" {
		return errors.New("profile name required")
	}
	cred.StoredAt = time.Now().UTC()
	raw, err := json.Marshal(cred)
	if err != nil {
		return err
	}
	return s.ring.Set(keyring.Item{
		Key:         profile,
		Data:        raw,
		Label:       "polaris-mail credential (" + profile + ")",
		Description: "polaris-mail operator bearer for profile " + profile,
	})
}

func (s *kr) Load(profile string) (*Credential, error) {
	if profile == "" {
		return nil, errors.New("profile name required")
	}
	item, err := s.ring.Get(profile)
	if err != nil {
		if errors.Is(err, keyring.ErrKeyNotFound) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("keyring get: %w", err)
	}
	var cred Credential
	if err := json.Unmarshal(item.Data, &cred); err != nil {
		return nil, fmt.Errorf("decode credential: %w", err)
	}
	return &cred, nil
}

func (s *kr) Delete(profile string) error {
	if profile == "" {
		return errors.New("profile name required")
	}
	if err := s.ring.Remove(profile); err != nil {
		if errors.Is(err, keyring.ErrKeyNotFound) {
			return ErrNotFound
		}
		return err
	}
	return nil
}

func (s *kr) List() ([]string, error) {
	keys, err := s.ring.Keys()
	if err != nil {
		return nil, err
	}
	return keys, nil
}

// ErrNotFound is returned when a profile entry doesn't exist.
var ErrNotFound = errors.New("credstore: no entry for that profile")

// New constructs a Store using the best available backend on this host.
func New() (Store, error) {
	cfgDir, err := defaultConfigDir()
	if err != nil {
		return nil, err
	}
	ring, err := keyring.Open(keyring.Config{
		ServiceName:                    serviceName,
		KeychainName:                   serviceName,
		KeychainTrustApplication:       true,
		KeychainSynchronizable:         false,
		KeychainAccessibleWhenUnlocked: true,
		LibSecretCollectionName:        serviceName,
		WinCredPrefix:                  serviceName,
		FileDir:                        filepath.Join(cfgDir, "keyring"),
		FilePasswordFunc:               promptPassphraseTTY,
		AllowedBackends: []keyring.BackendType{
			keyring.KeychainBackend,
			keyring.WinCredBackend,
			keyring.SecretServiceBackend,
			keyring.KWalletBackend,
			keyring.PassBackend,
			keyring.FileBackend,
		},
	})
	if err != nil {
		return nil, fmt.Errorf("open keyring: %w", err)
	}
	return &kr{ring: ring}, nil
}

// NewForTesting returns a Store backed by a passphrase-encrypted file in dir.
// Used by go tests and headless CI runners.
func NewForTesting(dir, passphrase string) (Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	ring, err := keyring.Open(keyring.Config{
		ServiceName:      serviceName,
		FileDir:          dir,
		FilePasswordFunc: keyring.FixedStringPrompt(passphrase),
		AllowedBackends:  []keyring.BackendType{keyring.FileBackend},
	})
	if err != nil {
		return nil, err
	}
	return &kr{ring: ring}, nil
}

func defaultConfigDir() (string, error) {
	if v := os.Getenv("POLARIS_CONFIG_DIR"); v != "" {
		return v, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, ".config", serviceName)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	return dir, nil
}

func promptPassphraseTTY(prompt string) (string, error) {
	return keyring.TerminalPrompt(strings.TrimRight(prompt, " :") + " for " + serviceName + ": ")
}

// ParseBearer splits a `polaris_{key_id}.{secret}` bearer into its parts.
func ParseBearer(bearer string) (keyID, secret string, err error) {
	bearer = strings.TrimSpace(bearer)
	const prefix = "polaris_"
	if !strings.HasPrefix(bearer, prefix) {
		return "", "", errors.New("bearer must start with `polaris_`")
	}
	rest := bearer[len(prefix):]
	idx := strings.IndexByte(rest, '.')
	if idx <= 0 || idx == len(rest)-1 {
		return "", "", errors.New("bearer must be `polaris_{key_id}.{secret}`")
	}
	keyID = rest[:idx]
	secret = rest[idx+1:]
	if len(keyID) != 26 {
		return "", "", fmt.Errorf("key_id must be 26 chars (got %d)", len(keyID))
	}
	return keyID, secret, nil
}

// FormatBearer is the inverse of ParseBearer.
func FormatBearer(keyID, secret string) string {
	return "polaris_" + keyID + "." + secret
}
