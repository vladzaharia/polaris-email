package cfapi

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
)

// WorkerScript is the trimmed shape returned by Cloudflare's
// workers/scripts list/get endpoints — only the fields setup needs to
// reconstruct deploy records.
type WorkerScript struct {
	ID         string   `json:"id"`
	CreatedOn  string   `json:"created_on,omitempty"`
	ModifiedOn string   `json:"modified_on,omitempty"`
	Etag       string   `json:"etag,omitempty"`
	Handlers   []string `json:"handlers,omitempty"`
}

// ListScripts returns every Worker script under the account.
func (c *Client) ListScripts(ctx context.Context) ([]WorkerScript, error) {
	var out []WorkerScript
	if err := c.do(ctx, http.MethodGet, c.accountPath("/workers/scripts"), nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// WorkerCustomDomain is one row from `GET /accounts/{id}/workers/domains`.
// `Service` is the Worker name the domain is attached to.
type WorkerCustomDomain struct {
	ID          string `json:"id"`
	ZoneID      string `json:"zone_id"`
	ZoneName    string `json:"zone_name"`
	Hostname    string `json:"hostname"`
	Service     string `json:"service"`
	Environment string `json:"environment"`
}

// ListWorkerCustomDomains returns every Workers Custom Domain bound on
// the account. Cloudflare paginates with page/per_page; we follow until
// the page returns less than per_page entries.
func (c *Client) ListWorkerCustomDomains(ctx context.Context) ([]WorkerCustomDomain, error) {
	var all []WorkerCustomDomain
	page := 1
	for {
		q := url.Values{}
		q.Set("page", fmt.Sprintf("%d", page))
		q.Set("per_page", "100")
		var batch []WorkerCustomDomain
		if err := c.do(ctx, http.MethodGet, c.accountPath("/workers/domains")+"?"+q.Encode(), nil, &batch); err != nil {
			return nil, err
		}
		all = append(all, batch...)
		if len(batch) < 100 {
			return all, nil
		}
		page++
	}
}

// DeleteWorkerCustomDomain removes a Workers Custom Domain by ID. 404 is
// treated as success.
func (c *Client) DeleteWorkerCustomDomain(ctx context.Context, id string) error {
	if id == "" {
		return fmt.Errorf("cfapi: worker custom domain id required")
	}
	err := c.do(ctx, http.MethodDelete, c.accountPath("/workers/domains/"+url.PathEscape(id)), nil, nil)
	if err == nil || IsNotFound(err) {
		return nil
	}
	return err
}

// DeleteScript removes a Worker script (and its bindings/triggers) by
// name. 404 is treated as success (the script was already gone).
// Force=true also detaches the script from any service-bindings that
// still reference it; without that, CF refuses to delete if other
// Workers consume it via service-binding.
func (c *Client) DeleteScript(ctx context.Context, name string) error {
	if name == "" {
		return fmt.Errorf("cfapi: worker name required")
	}
	err := c.do(ctx, http.MethodDelete, c.accountPath("/workers/scripts/"+url.PathEscape(name))+"?force=true", nil, nil)
	if err == nil || IsNotFound(err) {
		return nil
	}
	return err
}

// GetScript fetches metadata for a single script. The "/<name>" suffix
// returns the script body; we instead query the settings endpoint which
// keeps the response small.
func (c *Client) GetScript(ctx context.Context, name string) (*WorkerScript, error) {
	if name == "" {
		return nil, fmt.Errorf("cfapi: worker name required")
	}
	all, err := c.ListScripts(ctx)
	if err != nil {
		return nil, err
	}
	for i := range all {
		if all[i].ID == name {
			return &all[i], nil
		}
	}
	// Fall back to a direct fetch — useful if the list endpoint is
	// paginated and we missed a page (defensive only).
	var ws WorkerScript
	if err := c.do(ctx, http.MethodGet, c.accountPath("/workers/scripts/"+url.PathEscape(name)), nil, &ws); err != nil {
		return nil, err
	}
	if ws.ID == "" {
		ws.ID = name
	}
	return &ws, nil
}
