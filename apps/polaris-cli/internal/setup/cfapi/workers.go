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
