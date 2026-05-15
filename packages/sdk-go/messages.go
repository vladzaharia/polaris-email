// Hand-written Go SDK methods for the Phase L bridge endpoints.
//
// These mirror the JSON shapes returned by `services/api/src/routes/messages-state.ts`
// and `services/api/src/routes/admin/credentials-mailbox.ts`. They are NOT
// generated; treat this file as the source of truth until oapi-codegen
// recovers it.
package polarissdk

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
)

// (errors are defined in errors.go)

// Attachment is the inline attachment shape returned by UnifiedMessage.
type Attachment struct {
	ContentType   string `json:"content_type"`
	Filename      string `json:"filename,omitempty"`
	SizeBytes     int64  `json:"size_bytes"`
	ContentBase64 string `json:"content_base64,omitempty"`
	ContentURL    string `json:"content_url,omitempty"`
}

// Message is a subset of the polaris `UnifiedMessage` shape — enough for the
// bridge to render IMAP responses.
type Message struct {
	ID                    string       `json:"id"`
	MailboxID             string       `json:"mailbox_id"`
	Direction             string       `json:"direction"`
	Status                string       `json:"status"`
	From                  string       `json:"from,omitempty"`
	FromAddr              string       `json:"from_addr,omitempty"`
	To                    []string     `json:"to,omitempty"`
	Subject               string       `json:"subject,omitempty"`
	ThreadID              string       `json:"thread_id,omitempty"`
	HeaderMessageID       string       `json:"header_message_id,omitempty"`
	BodyBytes             int64        `json:"body_bytes,omitempty"`
	AttachmentsTotalBytes int64        `json:"attachments_total_bytes,omitempty"`
	Text                  string       `json:"text,omitempty"`
	HTML                  string       `json:"html,omitempty"`
	Attachments           []Attachment `json:"attachments,omitempty"`
	CreatedAt             string       `json:"created_at,omitempty"`
	ReceivedAtAPI         string       `json:"received_at_api,omitempty"`
	Flags                 []string     `json:"flags,omitempty"`
	ReadAt                string       `json:"read_at,omitempty"`
	ChangeID              int64        `json:"change_id,omitempty"`
}

// BulkGetResponse is the body of POST /v1/messages/get.
type BulkGetResponse struct {
	Data     []Message `json:"data"`
	NotFound []string  `json:"not_found"`
}

// ExpungeResponse is the body of POST /v1/mailboxes/:id/expunge.
type ExpungeResponse struct {
	Removed int `json:"removed"`
	R2Freed int `json:"r2_freed"`
}

// ChangesResponse is the body of GET /v1/mailboxes/:id/changes.
type ChangesResponse struct {
	Added   []string `json:"added"`
	Updated []string `json:"updated"`
	Deleted []string `json:"deleted"`
	State   int64    `json:"state"`
}

// MessageListResponse wraps {data:[...]} list endpoints.
type MessageListResponse struct {
	Data []Message `json:"data"`
}

// CreateWebhookSubRequest matches the POST /v1/admin/webhook-subs body.
type CreateWebhookSubRequest struct {
	MailboxID string   `json:"mailbox_id"`
	URL       string   `json:"url"`
	Kind      string   `json:"kind"` // "external" | "tailnet" | "polaris"
	Events    []string `json:"events"`
}

// CreateWebhookSubResponse is the issuance result.
type CreateWebhookSubResponse struct {
	ID     string `json:"id"`
	Secret string `json:"secret"`
}

// WebhookSub is one row in webhook_subs.
type WebhookSub struct {
	ID         string   `json:"id"`
	MailboxID  string   `json:"mailbox_id"`
	URL        string   `json:"url"`
	Kind       string   `json:"kind"`
	Events     []string `json:"events"`
	PausedAt   string   `json:"paused_at,omitempty"`
	CreatedAt  string   `json:"created_at"`
	DisabledAt string   `json:"disabled_at,omitempty"`
}

// CredentialLookup is the (daemon-only) credential row used by the bridge.
type CredentialLookup struct {
	ID         string `json:"id"`
	MailboxID  string `json:"mailbox_id"`
	Protocol   string `json:"protocol"`
	AuthType   string `json:"auth_type"`
	Username   string `json:"username,omitempty"`
	BcryptHash string `json:"bcrypt_hash,omitempty"`
}

// --- helpers ---

func (c *Client) doJSON(
	ctx context.Context,
	method, path, query string,
	body []byte,
	out any,
) error {
	resp, rb, err := c.Do(ctx, method, path, query, body, "application/json", nil)
	if err != nil {
		// Network / transport error — return wrapped so callers using
		// errors.Is(err, context.DeadlineExceeded) and similar still work.
		return err
	}
	if resp.StatusCode >= 400 {
		return ParseAPIError(resp.StatusCode, rb, resp.Header)
	}
	if out == nil || len(rb) == 0 {
		return nil
	}
	return json.Unmarshal(rb, out)
}

// PatchMessageFlags sends PATCH /v1/messages/:id { flags: [...] } and returns
// the updated message representation.
func (c *Client) PatchMessageFlags(ctx context.Context, id string, flags []string) (*Message, error) {
	body, err := json.Marshal(map[string]any{"flags": flags})
	if err != nil {
		return nil, err
	}
	var m Message
	if err := c.doJSON(ctx, "PATCH", "/v1/messages/"+id, "", body, &m); err != nil {
		return nil, err
	}
	return &m, nil
}

// DeleteMessage soft-expunges a message.
func (c *Client) DeleteMessage(ctx context.Context, id string) error {
	return c.doJSON(ctx, "DELETE", "/v1/messages/"+id, "", nil, nil)
}

// BulkGetMessages performs a bulk fetch by id.
func (c *Client) BulkGetMessages(ctx context.Context, ids []string) (*BulkGetResponse, error) {
	body, err := json.Marshal(map[string]any{"ids": ids})
	if err != nil {
		return nil, err
	}
	var r BulkGetResponse
	if err := c.doJSON(ctx, "POST", "/v1/messages/get", "", body, &r); err != nil {
		return nil, err
	}
	return &r, nil
}

// GetMessage retrieves a single message representation. Falls back to bulk-get
// to avoid duplicating render logic.
func (c *Client) GetMessage(ctx context.Context, id string) (*Message, error) {
	r, err := c.BulkGetMessages(ctx, []string{id})
	if err != nil {
		return nil, err
	}
	if len(r.Data) == 0 {
		return nil, fmt.Errorf("polaris-sdk-go: message %s not found", id)
	}
	return &r.Data[0], nil
}

// ExpungeMailbox hard-purges soft-expunged messages.
func (c *Client) ExpungeMailbox(ctx context.Context, mailboxID string) (*ExpungeResponse, error) {
	var r ExpungeResponse
	if err := c.doJSON(ctx, "POST", "/v1/mailboxes/"+mailboxID+"/expunge", "", []byte("{}"), &r); err != nil {
		return nil, err
	}
	return &r, nil
}

// GetMailboxChanges returns the mailbox change delta since the given state.
func (c *Client) GetMailboxChanges(ctx context.Context, mailboxID string, sinceState int64) (*ChangesResponse, error) {
	q := url.Values{}
	q.Set("since_state", strconv.FormatInt(sinceState, 10))
	var r ChangesResponse
	if err := c.doJSON(ctx, "GET", "/v1/mailboxes/"+mailboxID+"/changes", q.Encode(), nil, &r); err != nil {
		return nil, err
	}
	return &r, nil
}

// ListMailboxMessagesMetadata is the bridge bootstrap endpoint: returns
// metadata-only message rows (no body, no attachment bytes).
func (c *Client) ListMailboxMessagesMetadata(ctx context.Context, mailboxID string, limit, offset int) (*MessageListResponse, error) {
	if limit <= 0 {
		limit = 100
	}
	q := url.Values{}
	q.Set("fields", "metadata")
	q.Set("limit", strconv.Itoa(limit))
	q.Set("offset", strconv.Itoa(offset))
	var r MessageListResponse
	if err := c.doJSON(ctx, "GET", "/v1/mailboxes/"+mailboxID+"/messages", q.Encode(), nil, &r); err != nil {
		return nil, err
	}
	return &r, nil
}

// CreateWebhookSub registers a webhook subscription pointing at the bridge.
func (c *Client) CreateWebhookSub(ctx context.Context, req CreateWebhookSubRequest) (*CreateWebhookSubResponse, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	var r CreateWebhookSubResponse
	if err := c.doJSON(ctx, "POST", "/v1/admin/webhook-subs", "", body, &r); err != nil {
		return nil, err
	}
	return &r, nil
}

// ListWebhookSubs lists webhook subscriptions, optionally filtered by mailbox.
func (c *Client) ListWebhookSubs(ctx context.Context, mailboxID string) ([]WebhookSub, error) {
	q := ""
	if mailboxID != "" {
		v := url.Values{}
		v.Set("mailbox_id", mailboxID)
		q = v.Encode()
	}
	var r struct {
		Data []WebhookSub `json:"data"`
	}
	if err := c.doJSON(ctx, "GET", "/v1/admin/webhook-subs", q, nil, &r); err != nil {
		return nil, err
	}
	return r.Data, nil
}

// LookupMailboxCredential resolves a (protocol, username) pair to the stored
// credential row. Daemon-scoped; bridges call this to verify IMAP LOGIN.
func (c *Client) LookupMailboxCredential(ctx context.Context, protocol, username string) (*CredentialLookup, error) {
	q := url.Values{}
	q.Set("protocol", protocol)
	q.Set("username", username)
	var r CredentialLookup
	if err := c.doJSON(ctx, "GET", "/v1/daemon/credentials/lookup", q.Encode(), nil, &r); err != nil {
		return nil, err
	}
	return &r, nil
}

