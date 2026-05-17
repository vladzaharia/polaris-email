// TTL'd in-process cache for fingerprint → operator lookups so the Wish
// server doesn't hit the Polaris API on every SSH connect.
//
// Cache invalidation is TTL-only; per-request server-side re-checks
// (`/v1/admin/operators/lookup` is called once per session, and every
// authenticated API call inside the session re-checks `disabled_at` via
// the auth middleware) provide the live revocation signal.
package sshserver

import (
	"context"
	"net/url"
	"sync"
	"time"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
)

// Cache wraps a polaris client and caches operator lookups by fingerprint.
type Cache struct {
	cli    *client.Client
	ttl    time.Duration
	mu     sync.Mutex
	byFp   map[string]cacheEntry
}

type cacheEntry struct {
	operator *client.Operator
	at       time.Time
}

// NewCache constructs a Cache.
func NewCache(cli *client.Client, ttl time.Duration) *Cache {
	if ttl <= 0 {
		ttl = 5 * time.Minute
	}
	return &Cache{cli: cli, ttl: ttl, byFp: map[string]cacheEntry{}}
}

// Lookup resolves a fingerprint to an Operator. Returns (nil, nil) for
// unknown fingerprints (the caller renders a friendly rejection).
func (c *Cache) Lookup(ctx context.Context, fingerprint string) (*client.Operator, error) {
	c.mu.Lock()
	if e, ok := c.byFp[fingerprint]; ok && time.Since(e.at) < c.ttl {
		c.mu.Unlock()
		return e.operator, nil
	}
	c.mu.Unlock()

	q := url.Values{"fingerprint": {fingerprint}}
	var resp struct {
		Operator *client.Operator `json:"operator"`
	}
	if err := c.cli.DoJSON(ctx, "GET", "/v1/admin/operators/lookup", q, nil, &resp); err != nil {
		if httpErr, ok := err.(*client.HTTPError); ok && httpErr.Status == 404 {
			c.mu.Lock()
			c.byFp[fingerprint] = cacheEntry{operator: nil, at: time.Now()}
			c.mu.Unlock()
			return nil, nil
		}
		return nil, err
	}
	c.mu.Lock()
	c.byFp[fingerprint] = cacheEntry{operator: resp.Operator, at: time.Now()}
	c.mu.Unlock()
	return resp.Operator, nil
}

// Forget evicts a single entry — exposed for tests + future admin RPC.
func (c *Cache) Forget(fingerprint string) {
	c.mu.Lock()
	delete(c.byFp, fingerprint)
	c.mu.Unlock()
}
