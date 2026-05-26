package credstore

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"sync/atomic"
	"time"

	polarissdk "github.com/polaris-mail/polaris-sdk-go"
)

// PollerConfig configures the poller HTTP calls.
type PollerConfig struct {
	APIURL   string
	HMACKey  []byte
	BridgeID string
	Interval time.Duration
}

// Poller periodically pulls credential deltas from the bridge credentials API.
type Poller struct {
	cfg    PollerConfig
	store  *Store
	client *polarissdk.Client
	ready  atomic.Bool
}

// NewPoller constructs a Poller.
func NewPoller(cfg PollerConfig, store *Store) *Poller {
	c := polarissdk.NewClient(cfg.APIURL)
	c.HTTPClient = &http.Client{Timeout: 30 * time.Second}
	c.BridgeID = cfg.BridgeID
	c.BridgeSecret = cfg.HMACKey
	// No ExtraHeaders — the polaris API isn't fronted by CF Access; the
	// bridge HMAC is the only auth surface (see project memory).
	return &Poller{cfg: cfg, store: store, client: c}
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
	query := "since=" + strconv.FormatInt(since, 10)
	resp, body, err := p.client.Do(ctx, "GET", "/v1/bridge/credentials", query, nil, "", nil)
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("status %d: %s", resp.StatusCode, string(body))
	}
	var dr deltaResponse
	if err := json.Unmarshal(body, &dr); err != nil {
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
