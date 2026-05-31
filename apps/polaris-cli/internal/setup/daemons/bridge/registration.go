package bridge

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/platform"
)

// SecretsLayout lays out the four credential files plus the
// audit-once registration.json. All paths are joined under <dir>.
type SecretsLayout struct {
	Dir              string
	BridgeIDPath     string
	HMACKeyPath      string
	AccessIDPath     string
	AccessSecretPath string
	RegistrationPath string
}

// NewSecretsLayout returns the canonical layout under <projectDir>.
func NewSecretsLayout(projectDir string) SecretsLayout {
	secrets := filepath.Join(projectDir, "secrets")
	return SecretsLayout{
		Dir:              secrets,
		BridgeIDPath:     filepath.Join(secrets, "bridge_id"),
		HMACKeyPath:      filepath.Join(secrets, "hmac_key"),
		AccessIDPath:     filepath.Join(secrets, "access_client_id"),
		AccessSecretPath: filepath.Join(secrets, "access_client_secret"),
		RegistrationPath: filepath.Join(projectDir, "registration.json"),
	}
}

// RegistrationData is the subset of BridgeRegisterResponse we persist.
// We avoid importing internal/client here to keep this package free
// of cobra/wizard deps; cmd/setup_bridge.go does the adapter dance.
type RegistrationData struct {
	BridgeID           string
	BridgeName         string
	Environment        string
	HMACKeyID          string
	HMACSecret         string
	AccessClientID     string
	AccessClientSecret string
	RegisteredAt       time.Time
	Raw                json.RawMessage // full server response for audit
}

// PersistRegistration writes the four secrets files + registration.json
// + .polaris-setup.json (input snapshot). The secrets/ directory is
// chmod'd to 0700 first.
func PersistRegistration(projectDir string, in *BridgeSetupInput, reg *RegistrationData) (SecretsLayout, error) {
	layout := NewSecretsLayout(projectDir)
	if err := platform.EnsureDir(layout.Dir, 0o700); err != nil {
		return layout, err
	}
	writes := []struct {
		path string
		body []byte
	}{
		{layout.BridgeIDPath, []byte(reg.BridgeID)},
		{layout.HMACKeyPath, []byte(reg.HMACSecret)},
		{layout.AccessIDPath, []byte(reg.AccessClientID)},
		{layout.AccessSecretPath, []byte(reg.AccessClientSecret)},
	}
	for _, w := range writes {
		if err := platform.AtomicWrite(w.path, w.body, 0o600); err != nil {
			return layout, fmt.Errorf("write %s: %w", w.path, err)
		}
	}
	// registration.json — the full server response, kept once for
	// operator audit. Marshaled compactly if reg.Raw was supplied, or
	// rebuilt from the typed fields otherwise.
	regBody := reg.Raw
	if len(regBody) == 0 {
		var err error
		regBody, err = json.MarshalIndent(reg, "", "  ")
		if err != nil {
			return layout, err
		}
	}
	if err := platform.AtomicWrite(layout.RegistrationPath, regBody, 0o600); err != nil {
		return layout, fmt.Errorf("write registration.json: %w", err)
	}
	// Input snapshot — secret values replaced with sentinels.
	snap := SnapshotInput(in)
	snapBody, err := json.MarshalIndent(snap, "", "  ")
	if err != nil {
		return layout, err
	}
	snapPath := filepath.Join(projectDir, ".polaris-setup.json")
	if err := platform.AtomicWrite(snapPath, snapBody, 0o600); err != nil {
		return layout, fmt.Errorf("write .polaris-setup.json: %w", err)
	}
	return layout, nil
}

// SnapshotInput replaces any secret-bearing value with a sentinel that
// references the on-disk secrets file. Used for the operator-visible
// .polaris-setup.json so a later drift detection can compare inputs
// without dragging secrets along.
func SnapshotInput(in *BridgeSetupInput) map[string]any {
	out := map[string]any{
		"mode":            in.Mode,
		"bridge_name":     in.BridgeName,
		"environment":     in.Environment,
		"polaris_api_url": in.PolarisAPIURL,
		"tls_source":      in.TLSSource,
		"fqdn":            in.FQDN,
		"smtps_port":      in.SMTPSPort,
		"imap_port":       in.IMAPPort,
		"webhook_port":    in.WebhookPort,
		"tls_dir":         in.TLSDir,
		"acme_email":      in.ACMEEmail,
		"region":          in.Region,
		"image_tag":       in.ImageTag,
		"dir":             in.Dir,
		// Sentinels for the credentials persisted to <dir>/secrets/.
		"bridge_id":            "file:secrets/bridge_id",
		"hmac_secret":          "file:secrets/hmac_key",
		"access_client_id":     "file:secrets/access_client_id",
		"access_client_secret": "file:secrets/access_client_secret",
	}
	return out
}

// LoadRegistration is the inverse of PersistRegistration — read the
// secrets back into memory for `setup bridge status` / `up`. Files
// with non-0600 mode are remediated in-place.
func LoadRegistration(projectDir string) (*RegistrationData, error) {
	layout := NewSecretsLayout(projectDir)
	for _, p := range []string{layout.BridgeIDPath, layout.HMACKeyPath, layout.AccessIDPath, layout.AccessSecretPath} {
		if _, err := os.Stat(p); err != nil {
			return nil, fmt.Errorf("missing secret %s: %w", p, err)
		}
		_ = platform.EnforceMode(p, 0o600)
	}
	read := func(p string) (string, error) {
		b, err := os.ReadFile(p)
		if err != nil {
			return "", err
		}
		return string(b), nil
	}
	bridgeID, err := read(layout.BridgeIDPath)
	if err != nil {
		return nil, err
	}
	hmacKey, err := read(layout.HMACKeyPath)
	if err != nil {
		return nil, err
	}
	accID, err := read(layout.AccessIDPath)
	if err != nil {
		return nil, err
	}
	accSec, err := read(layout.AccessSecretPath)
	if err != nil {
		return nil, err
	}
	return &RegistrationData{
		BridgeID:           bridgeID,
		HMACSecret:         hmacKey,
		AccessClientID:     accID,
		AccessClientSecret: accSec,
	}, nil
}
