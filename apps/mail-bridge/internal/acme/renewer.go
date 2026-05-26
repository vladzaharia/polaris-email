// Package acme is the bridge's embedded ACME loop.
//
// One Renewer per bridge process. Responsibilities, executed on
// startup (`EnsureCert`) and on a 24h timer (`Start`):
//
//  1. Maintain the bridge's own A record in CF DNS (private/docker-
//     network IP). Other services on the same network resolve
//     `<bridgename>.mail.plrs.im` to reach the bridge by FQDN.
//  2. Mint or renew the LE certificate for the bridge FQDN via Lego's
//     Cloudflare DNS-01 provider, using the per-bridge CF token
//     fetched from `/v1/bridge/config`.
//  3. Persist the cert + key to disk so `internal/tls.Source`'s
//     existing 30s GetCertificate reload cadence picks them up
//     without a process restart.
//
// Renewal trigger: cert expiry < 30d. Lego itself enforces the LE
// rate limits; the 24h check cadence + 30d threshold keep us
// comfortably below the 5-certs-per-7d-per-FQDN ceiling even under
// catastrophic looping.
//
// User key: Lego needs a registered ACME account. We generate an EC
// private key on first run and persist it at `<CertDir>/account.key`;
// the registration is implicit (one extra ACME round-trip the first
// time we call ObtainCert, then cached locally in `<CertDir>/
// account.json`).

package acme

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/go-acme/lego/v4/certcrypto"
	"github.com/go-acme/lego/v4/certificate"
	"github.com/go-acme/lego/v4/lego"
	"github.com/go-acme/lego/v4/providers/dns/cloudflare"
	"github.com/go-acme/lego/v4/registration"
)

// Renewer owns the bridge's certificate + A-record lifecycle.
type Renewer struct {
	FQDN       string
	AcmeEmail  string
	CFDnsToken string
	CFZoneID   string
	CertDir    string         // /var/lib/polaris-bridge/certs
	Interval   time.Duration  // 24h between renewal checks; injectable for tests
	BridgeIP   string         // current IP for the A record; "" disables A-record upsert
	Now        func() time.Time

	// ACMEDirectory overrides lego's default (production LE). Tests point
	// this at pebble or staging-LE. Empty string means production.
	ACMEDirectory string
}

const (
	defaultRenewalInterval = 24 * time.Hour
	// LE certs live 90d; renew when 30d remain so we have a wide
	// retry window if a renewal attempt fails transiently.
	renewalThreshold = 30 * 24 * time.Hour
)

func (r *Renewer) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

// Paths returns the cert/key paths owned by this renewer. The
// internal/tls.Source watches both for changes (30s reload cadence).
func (r *Renewer) Paths() (cert string, key string) {
	return filepath.Join(r.CertDir, "fullchain.pem"),
		filepath.Join(r.CertDir, "privkey.pem")
}

// EnsureCert performs one cycle: upsert A record, then mint a cert if
// missing or close to expiry. Blocking; suitable to call during
// startup.
func (r *Renewer) EnsureCert(ctx context.Context) error {
	if err := os.MkdirAll(r.CertDir, 0o700); err != nil {
		return fmt.Errorf("acme: mkdir cert dir: %w", err)
	}
	if r.BridgeIP != "" && r.CFZoneID != "" {
		// A record is best-effort: a failure here doesn't block ACME,
		// just other services' ability to resolve us by FQDN.
		cli := &CFDnsClient{APIToken: r.CFDnsToken, ZoneID: r.CFZoneID}
		if err := cli.UpsertA(ctx, r.FQDN, r.BridgeIP); err != nil {
			log.Printf("acme: A record upsert failed (continuing): %v", err)
		} else {
			log.Printf("acme: A record %s → %s OK", r.FQDN, r.BridgeIP)
		}
	}

	certPath, keyPath := r.Paths()
	if !r.certNeedsRenewal(certPath) {
		log.Printf("acme: cert at %s is current — skipping issue", certPath)
		return nil
	}

	user, err := r.loadOrCreateUser()
	if err != nil {
		return fmt.Errorf("acme: user: %w", err)
	}
	cfg := lego.NewConfig(user)
	if r.ACMEDirectory != "" {
		cfg.CADirURL = r.ACMEDirectory
	}
	cfg.Certificate.KeyType = certcrypto.EC256
	client, err := lego.NewClient(cfg)
	if err != nil {
		return fmt.Errorf("acme: lego client: %w", err)
	}
	provider, err := cloudflare.NewDNSProviderConfig(&cloudflare.Config{
		AuthToken: r.CFDnsToken,
		// `ZoneToken` defaults to AuthToken when unset; our token has
		// Zone:Read so Lego can resolve the zone-id by name.
	})
	if err != nil {
		return fmt.Errorf("acme: cf dns provider: %w", err)
	}
	if err := client.Challenge.SetDNS01Provider(provider); err != nil {
		return fmt.Errorf("acme: set dns-01 provider: %w", err)
	}
	if user.Registration == nil {
		reg, err := client.Registration.Register(registration.RegisterOptions{
			TermsOfServiceAgreed: true,
		})
		if err != nil {
			return fmt.Errorf("acme: register account: %w", err)
		}
		user.Registration = reg
		if err := r.persistUser(user); err != nil {
			log.Printf("acme: persist user (continuing, will re-register next time): %v", err)
		}
	}

	log.Printf("acme: requesting cert for %s", r.FQDN)
	res, err := client.Certificate.Obtain(certificate.ObtainRequest{
		Domains: []string{r.FQDN},
		Bundle:  true,
	})
	if err != nil {
		return fmt.Errorf("acme: obtain cert: %w", err)
	}
	if err := writeAtomic(certPath, res.Certificate, 0o644); err != nil {
		return fmt.Errorf("acme: write fullchain: %w", err)
	}
	if err := writeAtomic(keyPath, res.PrivateKey, 0o600); err != nil {
		return fmt.Errorf("acme: write privkey: %w", err)
	}
	log.Printf("acme: cert ready at %s", certPath)
	return nil
}

// Start runs EnsureCert on a 24h timer in a background goroutine.
// Exits when ctx is cancelled. Errors are logged but never propagated
// — a partial outage of LE or CF DNS shouldn't bring the bridge down.
func (r *Renewer) Start(ctx context.Context) {
	interval := r.Interval
	if interval == 0 {
		interval = defaultRenewalInterval
	}
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if err := r.EnsureCert(ctx); err != nil {
					log.Printf("acme: renewal cycle failed (continuing): %v", err)
				}
			}
		}
	}()
}

// certNeedsRenewal returns true if the cert file is missing, malformed,
// or expires within `renewalThreshold`.
func (r *Renewer) certNeedsRenewal(path string) bool {
	pemBytes, err := os.ReadFile(path)
	if err != nil {
		return true
	}
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return true
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return true
	}
	return r.now().Add(renewalThreshold).After(cert.NotAfter)
}

// ---------- ACME user persistence ----------

type acmeUser struct {
	Email        string
	Registration *registration.Resource
	key          crypto.PrivateKey
}

func (u *acmeUser) GetEmail() string                        { return u.Email }
func (u *acmeUser) GetRegistration() *registration.Resource { return u.Registration }
func (u *acmeUser) GetPrivateKey() crypto.PrivateKey        { return u.key }

func (r *Renewer) loadOrCreateUser() (*acmeUser, error) {
	keyPath := filepath.Join(r.CertDir, "account.key")
	regPath := filepath.Join(r.CertDir, "account.json")
	u := &acmeUser{Email: r.AcmeEmail}

	if keyBytes, err := os.ReadFile(keyPath); err == nil {
		block, _ := pem.Decode(keyBytes)
		if block == nil {
			return nil, errors.New("acme: account.key not pem")
		}
		k, err := x509.ParseECPrivateKey(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("acme: parse account.key: %w", err)
		}
		u.key = k
	} else {
		k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			return nil, fmt.Errorf("acme: generate account.key: %w", err)
		}
		der, err := x509.MarshalECPrivateKey(k)
		if err != nil {
			return nil, fmt.Errorf("acme: marshal account.key: %w", err)
		}
		buf := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der})
		if err := writeAtomic(keyPath, buf, 0o600); err != nil {
			return nil, fmt.Errorf("acme: write account.key: %w", err)
		}
		u.key = k
	}

	// Registration JSON is opaque to us; we hand it back to lego on
	// reload. Missing file is fine — caller triggers re-registration.
	if rb, err := os.ReadFile(regPath); err == nil {
		reg := &registration.Resource{}
		if err := unmarshalJSON(rb, reg); err == nil {
			u.Registration = reg
		}
	}
	return u, nil
}

func (r *Renewer) persistUser(u *acmeUser) error {
	regPath := filepath.Join(r.CertDir, "account.json")
	b, err := marshalJSON(u.Registration)
	if err != nil {
		return err
	}
	return writeAtomic(regPath, b, 0o600)
}

// ---------- low-level file helpers ----------

// writeAtomic writes a temp file in the same directory and renames it
// over the destination. Avoids partial writes if the bridge crashes
// mid-renewal.
func writeAtomic(dst string, data []byte, mode os.FileMode) error {
	tmp := dst + ".new"
	if err := os.WriteFile(tmp, data, mode); err != nil {
		return err
	}
	if err := os.Rename(tmp, dst); err != nil {
		// Don't leak the temp file on rename failure.
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func marshalJSON(v any) ([]byte, error)   { return json.Marshal(v) }
func unmarshalJSON(b []byte, v any) error { return json.Unmarshal(b, v) }
