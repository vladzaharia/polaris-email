package cfapi

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
)

// Queue mirrors the Cloudflare Queues v4 envelope.
type Queue struct {
	QueueID    string `json:"queue_id"`
	QueueName  string `json:"queue_name"`
	CreatedOn  string `json:"created_on,omitempty"`
	ModifiedOn string `json:"modified_on,omitempty"`
}

// ListQueues returns every queue under the account.
func (c *Client) ListQueues(ctx context.Context) ([]Queue, error) {
	var all []Queue
	page := 1
	for {
		q := url.Values{}
		q.Set("page", fmt.Sprintf("%d", page))
		q.Set("per_page", "100")
		var batch []Queue
		if err := c.do(ctx, http.MethodGet, c.accountPath("/queues")+"?"+q.Encode(), nil, &batch); err != nil {
			return nil, err
		}
		all = append(all, batch...)
		if len(batch) < 100 {
			return all, nil
		}
		page++
	}
}

// GetQueue fetches a queue by ID.
func (c *Client) GetQueue(ctx context.Context, id string) (*Queue, error) {
	if id == "" {
		return nil, fmt.Errorf("cfapi: queue id required")
	}
	var q Queue
	if err := c.do(ctx, http.MethodGet, c.accountPath("/queues/"+url.PathEscape(id)), nil, &q); err != nil {
		return nil, err
	}
	return &q, nil
}

// CreateQueue creates a queue with the given name. On already-exists,
// the existing record is fetched via re-list and returned.
func (c *Client) CreateQueue(ctx context.Context, name string) (*Queue, error) {
	if name == "" {
		return nil, fmt.Errorf("cfapi: queue name required")
	}
	body := map[string]any{"queue_name": name}
	var q Queue
	err := c.do(ctx, http.MethodPost, c.accountPath("/queues"), body, &q)
	if err == nil {
		return &q, nil
	}
	if IsAlreadyExists(err) {
		return c.findQueueByName(ctx, name)
	}
	return nil, err
}

func (c *Client) findQueueByName(ctx context.Context, name string) (*Queue, error) {
	all, err := c.ListQueues(ctx)
	if err != nil {
		return nil, fmt.Errorf("cfapi: re-list after queue 409: %w", err)
	}
	for i := range all {
		if all[i].QueueName == name {
			return &all[i], nil
		}
	}
	return nil, fmt.Errorf("cfapi: queue %q reported already-exists but no match on re-list", name)
}
