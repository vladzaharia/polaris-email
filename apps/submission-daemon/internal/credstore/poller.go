package credstore

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"sync/atomic"
	"time"
)

// PollerConfig configures the poller HTTP calls.
type PollerConfig struct {
	APIURL             string
	HMACKey            []byte
	DaemonID           string
	AccessClientID     string
	AccessClientSecret string
	Interval           time.Duration
}

// Poller periodically pulls credential deltas from the bridge API.
type Poller struct {
	cfg   PollerConfig
	store *Store
	http  *http.Client
	ready atomic.Bool
}

// NewPoller constructs a Poller.
func NewPoller(cfg PollerConfig, store *Store) *Poller {
	return &Poller{
		cfg:   cfg,
		store: store,
		http:  &http.Client{Timeout: 30 * time.Second},
	}
}

// Ready returns true after the first successful sync.
func (p *Poller) Ready() bool { return p.ready.Load() }

// Run blocks until ctx is done. Polls the API every cfg.Interval.
func (p *Poller) Run(ctx context.Context) {
	t := time.NewTicker(p.cfg.Interval)
	defer t.Stop()
	if err := p.syncOnce(ctx); err != nil {
		log.Printf("credstore: initial sync failed: %v", err)
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := p.syncOnce(ctx); err != nil {
				log.Printf("credstore: sync failed: %v", err)
			}
		}
	}
}

type deltaResponse struct {
	Updates       []Credential `json:"updates"`
	Deletions     []string     `json:"deletions"`
	MirrorVersion int64        `json:"mirror_version"`
}

func (p *Poller) syncOnce(ctx context.Context) error {
	since := p.store.MirrorVersion()
	url := fmt.Sprintf("%s/v1/bridge/credentials?since=%d", p.cfg.APIURL, since)
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return err
	}
	p.signRequest(req, "GET", fmt.Sprintf("/v1/bridge/credentials?since=%d", since), nil)
	req.Header.Set("CF-Access-Client-Id", p.cfg.AccessClientID)
	req.Header.Set("CF-Access-Client-Secret", p.cfg.AccessClientSecret)
	req.Header.Set("X-Polaris-Daemon-Id", p.cfg.DaemonID)

	resp, err := p.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("status %d: %s", resp.StatusCode, string(body))
	}

	var dr deltaResponse
	if err := json.NewDecoder(resp.Body).Decode(&dr); err != nil {
		return err
	}
	if err := p.store.UpsertBatch(dr.Updates); err != nil {
		return fmt.Errorf("upsert: %w", err)
	}
	for _, id := range dr.Deletions {
		if err := p.store.DeleteByID(id); err != nil {
			return fmt.Errorf("delete %s: %w", id, err)
		}
	}
	if err := p.store.SetMirrorVersion(dr.MirrorVersion); err != nil {
		return fmt.Errorf("set version: %w", err)
	}
	p.ready.Store(true)
	return nil
}

func (p *Poller) signRequest(req *http.Request, method, path string, body []byte) {
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	nonceBytes := make([]byte, 16)
	_, _ = rand.Read(nonceBytes)
	nonce := hex.EncodeToString(nonceBytes)
	bodyHash := sha256.Sum256(body)
	bodyHex := hex.EncodeToString(bodyHash[:])
	canonical := fmt.Sprintf("%s\n%s\n%s\n%s\n%s", method, path, bodyHex, ts, nonce)
	mac := hmac.New(sha256.New, p.cfg.HMACKey)
	mac.Write([]byte(canonical))
	sig := hex.EncodeToString(mac.Sum(nil))
	req.Header.Set("X-Polaris-HMAC", sig)
	req.Header.Set("X-Polaris-Timestamp", ts)
	req.Header.Set("X-Polaris-Nonce", nonce)
}
