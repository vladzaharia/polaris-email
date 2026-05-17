package cfapi

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
)

// KVNamespace mirrors the Cloudflare workers/kv namespace response.
type KVNamespace struct {
	ID                  string `json:"id"`
	Title               string `json:"title"`
	SupportsURLEncoding bool   `json:"supports_url_encoding,omitempty"`
}

// ListNamespaces returns every KV namespace under the account, following
// pagination until exhausted.
func (c *Client) ListNamespaces(ctx context.Context) ([]KVNamespace, error) {
	var all []KVNamespace
	page := 1
	for {
		q := url.Values{}
		q.Set("page", fmt.Sprintf("%d", page))
		q.Set("per_page", "100")
		var batch []KVNamespace
		if err := c.do(ctx, http.MethodGet, c.accountPath("/storage/kv/namespaces")+"?"+q.Encode(), nil, &batch); err != nil {
			return nil, err
		}
		all = append(all, batch...)
		if len(batch) < 100 {
			return all, nil
		}
		page++
	}
}

// GetNamespace fetches one namespace by ID.
func (c *Client) GetNamespace(ctx context.Context, id string) (*KVNamespace, error) {
	if id == "" {
		return nil, fmt.Errorf("cfapi: KV namespace id required")
	}
	var ns KVNamespace
	if err := c.do(ctx, http.MethodGet, c.accountPath("/storage/kv/namespaces/"+url.PathEscape(id)), nil, &ns); err != nil {
		return nil, err
	}
	return &ns, nil
}

// CreateNamespace creates a KV namespace with the given title. On
// already-exists, the existing namespace is found via re-list and
// returned.
func (c *Client) CreateNamespace(ctx context.Context, title string) (*KVNamespace, error) {
	if title == "" {
		return nil, fmt.Errorf("cfapi: KV title required")
	}
	body := map[string]any{"title": title}
	var ns KVNamespace
	err := c.do(ctx, http.MethodPost, c.accountPath("/storage/kv/namespaces"), body, &ns)
	if err == nil {
		return &ns, nil
	}
	if IsAlreadyExists(err) {
		return c.findNamespaceByTitle(ctx, title)
	}
	return nil, err
}

func (c *Client) findNamespaceByTitle(ctx context.Context, title string) (*KVNamespace, error) {
	all, err := c.ListNamespaces(ctx)
	if err != nil {
		return nil, fmt.Errorf("cfapi: re-list after KV 409: %w", err)
	}
	for i := range all {
		if all[i].Title == title {
			return &all[i], nil
		}
	}
	return nil, fmt.Errorf("cfapi: KV %q reported already-exists but no match on re-list", title)
}
