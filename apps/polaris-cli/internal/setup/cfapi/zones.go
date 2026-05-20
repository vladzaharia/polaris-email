package cfapi

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// Zone mirrors the trimmed Cloudflare zone shape. Only the fields setup
// needs are pinned; unknown fields are dropped on decode.
type Zone struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// ListZones returns every zone visible to the configured account.
// Cloudflare paginates with page/per_page; we follow until exhausted.
//
// NOTE: zones are account-scoped; the token's permissions decide what's
// visible. A "Zone:Read" scope is needed for this to populate.
func (c *Client) ListZones(ctx context.Context) ([]Zone, error) {
	var all []Zone
	page := 1
	for {
		q := url.Values{}
		q.Set("page", fmt.Sprintf("%d", page))
		q.Set("per_page", "50")
		// /zones is account-scoped via the bearer token (no /accounts/
		// path prefix). The CF API resolves the active account from the
		// token. The same call from a multi-account token will include
		// every zone — callers that need scoping should filter by Name.
		var batch []Zone
		if err := c.do(ctx, http.MethodGet, "/zones?"+q.Encode(), nil, &batch); err != nil {
			return nil, err
		}
		all = append(all, batch...)
		if len(batch) < 50 {
			return all, nil
		}
		page++
	}
}

// FindZoneIDForHost walks `host` (e.g. "r2.mail.plrs.im") leftwards
// looking for the longest-matching zone name in the account. Returns
// the zone ID, or "" + error when no matching zone exists.
//
// Used by callers that take a hostname from the operator but don't want
// to require them to track the underlying zone ID separately (R2 custom
// domain attach, Workers custom domain attach, …).
func (c *Client) FindZoneIDForHost(ctx context.Context, host string) (string, error) {
	if host == "" {
		return "", fmt.Errorf("cfapi: host required")
	}
	zones, err := c.ListZones(ctx)
	if err != nil {
		return "", fmt.Errorf("cfapi: list zones: %w", err)
	}
	// Build a name → id map so we can probe candidates by suffix.
	byName := map[string]string{}
	for _, z := range zones {
		byName[strings.ToLower(z.Name)] = z.ID
	}

	// Try the full host first, then strip one label at a time.
	// Longest match wins (so "sub.example.com" matches "sub.example.com"
	// before "example.com" if both happen to exist).
	candidate := strings.ToLower(strings.TrimSuffix(host, "."))
	for candidate != "" {
		if id, ok := byName[candidate]; ok {
			return id, nil
		}
		dot := strings.IndexByte(candidate, '.')
		if dot < 0 {
			break
		}
		candidate = candidate[dot+1:]
	}
	return "", fmt.Errorf("cfapi: no Cloudflare zone in this account covers host %q (token Zone:Read scope is required to discover zones)", host)
}
