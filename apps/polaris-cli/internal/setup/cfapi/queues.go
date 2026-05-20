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

// DeleteQueue removes a queue by ID. 404 is treated as success.
//
// CF refuses to delete a queue that's still referenced by either:
//   (a) a Worker consumer binding (`queues.consumers[].queue` in
//       another script's wrangler.jsonc), or
//   (b) another queue's `dead_letter_queue` setting.
// Detach with DeleteQueueConsumer / UnsetQueueDLQ before calling
// DeleteQueue when those references exist.
func (c *Client) DeleteQueue(ctx context.Context, id string) error {
	if id == "" {
		return fmt.Errorf("cfapi: queue id required")
	}
	err := c.do(ctx, http.MethodDelete, c.accountPath("/queues/"+url.PathEscape(id)), nil, nil)
	if err == nil || IsNotFound(err) {
		return nil
	}
	return err
}

// QueueConsumer is one entry from GET /accounts/{id}/queues/{queue_id}/consumers.
// `Script` is the Worker name; `ConsumerID` identifies this specific
// binding (a Worker may consume multiple queues, each a separate
// QueueConsumer row).
type QueueConsumer struct {
	ConsumerID string `json:"consumer_id"`
	Type       string `json:"type"` // "worker", "http_pull", …
	Script     string `json:"script_name,omitempty"`
}

// ListQueueConsumers returns every consumer bound to the named queue.
func (c *Client) ListQueueConsumers(ctx context.Context, queueID string) ([]QueueConsumer, error) {
	if queueID == "" {
		return nil, fmt.Errorf("cfapi: queue id required")
	}
	var consumers []QueueConsumer
	if err := c.do(ctx, http.MethodGet,
		c.accountPath("/queues/"+url.PathEscape(queueID)+"/consumers"),
		nil, &consumers); err != nil {
		return nil, err
	}
	return consumers, nil
}

// DeleteQueueConsumer unbinds a single Worker-consumer from a queue.
// 404 is treated as success.
func (c *Client) DeleteQueueConsumer(ctx context.Context, queueID, consumerID string) error {
	if queueID == "" || consumerID == "" {
		return fmt.Errorf("cfapi: queue id + consumer id required")
	}
	err := c.do(ctx, http.MethodDelete,
		c.accountPath("/queues/"+url.PathEscape(queueID)+"/consumers/"+url.PathEscape(consumerID)),
		nil, nil)
	if err == nil || IsNotFound(err) {
		return nil
	}
	return err
}

// QueueSettings carries the mutable knobs PATCH /queues/{id} accepts.
// Only DeadLetterQueue is wired today — extend when reset all (or
// another caller) needs more knobs.
type QueueSettings struct {
	DeadLetterQueue *string `json:"dead_letter_queue,omitempty"`
}

// PatchQueue updates one or more queue settings. Pass an empty string
// pointer for DeadLetterQueue to clear the DLQ binding (lets the DLQ
// itself be deleted afterwards).
func (c *Client) PatchQueue(ctx context.Context, queueID string, settings QueueSettings) error {
	if queueID == "" {
		return fmt.Errorf("cfapi: queue id required")
	}
	body := map[string]any{"settings": settings}
	return c.do(ctx, http.MethodPatch, c.accountPath("/queues/"+url.PathEscape(queueID)), body, nil)
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
