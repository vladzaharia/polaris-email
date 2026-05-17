package cfapi

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
)

// D1Database is the shape returned by Cloudflare's D1 list/get endpoints.
// Only the fields the setup flow needs are pinned here; unknown fields
// are silently dropped by encoding/json.
type D1Database struct {
	UUID      string `json:"uuid"`
	Name      string `json:"name"`
	CreatedAt string `json:"created_at"`
	Version   string `json:"version,omitempty"`
}

// ListDatabases returns every D1 database under the configured account.
// Cloudflare paginates with `page`/`per_page`; we follow until exhausted.
func (c *Client) ListDatabases(ctx context.Context) ([]D1Database, error) {
	var all []D1Database
	page := 1
	for {
		q := url.Values{}
		q.Set("page", fmt.Sprintf("%d", page))
		q.Set("per_page", "100")
		var batch []D1Database
		if err := c.do(ctx, http.MethodGet, c.accountPath("/d1/database")+"?"+q.Encode(), nil, &batch); err != nil {
			return nil, err
		}
		all = append(all, batch...)
		if len(batch) < 100 {
			return all, nil
		}
		page++
	}
}

// GetDatabase fetches one database by UUID.
func (c *Client) GetDatabase(ctx context.Context, uuid string) (*D1Database, error) {
	if uuid == "" {
		return nil, fmt.Errorf("cfapi: D1 UUID required")
	}
	var db D1Database
	if err := c.do(ctx, http.MethodGet, c.accountPath("/d1/database/"+url.PathEscape(uuid)), nil, &db); err != nil {
		return nil, err
	}
	return &db, nil
}

// CreateDatabase creates a new D1 database with the given name. If the
// database already exists (HTTP 409 or CF "already exists" code), it
// re-lists and returns the existing record — this is the idempotency
// contract every cfapi Create method honors.
func (c *Client) CreateDatabase(ctx context.Context, name string) (*D1Database, error) {
	if name == "" {
		return nil, fmt.Errorf("cfapi: D1 name required")
	}
	body := map[string]any{"name": name}
	var db D1Database
	err := c.do(ctx, http.MethodPost, c.accountPath("/d1/database"), body, &db)
	if err == nil {
		return &db, nil
	}
	if IsAlreadyExists(err) {
		return c.findDatabaseByName(ctx, name)
	}
	return nil, err
}

func (c *Client) findDatabaseByName(ctx context.Context, name string) (*D1Database, error) {
	all, err := c.ListDatabases(ctx)
	if err != nil {
		return nil, fmt.Errorf("cfapi: re-list after 409: %w", err)
	}
	for i := range all {
		if all[i].Name == name {
			return &all[i], nil
		}
	}
	return nil, fmt.Errorf("cfapi: D1 %q reported already-exists but no match on re-list", name)
}
