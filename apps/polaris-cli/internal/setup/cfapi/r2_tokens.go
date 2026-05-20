package cfapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
)

// CF permission-group IDs for R2-scoped tokens. These are global, stable
// identifiers Cloudflare uses to describe what a token can do. The
// "Workers R2 Storage Bucket Item Write" group corresponds to the
// "Object Read & Write" UI permission and works whether the token is
// scoped to a single bucket or all buckets.
//
// Reference: https://developers.cloudflare.com/r2/api/tokens/#permission-groups
const (
	r2StorageBucketItemWriteID = "2efd5506f9c8494dacb1fa10a3e7d5b6"
	r2StorageBucketItemReadID  = "6a018a9f2fc74eb6b293b0c548f38b39"
)

// R2APIToken is the minted credential set the caller consumes. CF returns
// the secret token value EXACTLY ONCE at creation; lose it and the token
// has to be deleted + re-minted.
//
// Cloudflare's R2 S3-compatible endpoint expects:
//   - AccessKeyID = the token's `id` field
//   - SecretAccessKey = sha256_hex(token.value)
//
// We compute both eagerly so callers can persist the S3 credentials
// directly without rerunning the SHA-256 themselves.
type R2APIToken struct {
	ID              string
	Name            string
	AccessKeyID     string
	SecretAccessKey string
}

// CreateR2APITokenInput configures the bucket-scoped API token.
//
// Name identifies the token (operator-visible in the CF dashboard).
// Bucket is the R2 bucket the token may read/write — scope is enforced
// server-side. Permission selects one of:
//
//   - "object-read-write" (default; same as the dashboard's "Object Read & Write")
//   - "object-read-only"
type CreateR2APITokenInput struct {
	Name       string
	Bucket     string
	Permission string
}

// CreateR2APIToken mints a new R2-scoped API token via the standard
// `POST /accounts/{id}/tokens` endpoint. CF returns the secret token
// value once; this function derives the S3 access/secret pair from it
// and returns both so callers can persist them directly.
func (c *Client) CreateR2APIToken(ctx context.Context, in CreateR2APITokenInput) (*R2APIToken, error) {
	if in.Name == "" {
		return nil, fmt.Errorf("cfapi: r2 token name required")
	}
	if in.Bucket == "" {
		return nil, fmt.Errorf("cfapi: r2 token bucket required")
	}
	permGroup := r2StorageBucketItemWriteID
	switch in.Permission {
	case "", "object-read-write":
		// default
	case "object-read-only":
		permGroup = r2StorageBucketItemReadID
	default:
		return nil, fmt.Errorf("cfapi: unsupported r2 token permission %q (want object-read-write or object-read-only)", in.Permission)
	}

	// Resource key shape per CF docs:
	//   com.cloudflare.edge.r2.bucket.<account_id>_<jurisdiction>_<bucket>
	// Jurisdiction is "default" for default-jurisdiction buckets.
	resourceKey := fmt.Sprintf("com.cloudflare.edge.r2.bucket.%s_default_%s", c.AccountID, in.Bucket)

	body := map[string]any{
		"name": in.Name,
		"policies": []map[string]any{
			{
				"effect": "allow",
				"resources": map[string]any{
					resourceKey: "*",
				},
				"permission_groups": []map[string]any{
					{"id": permGroup},
				},
			},
		},
	}

	var resp struct {
		ID    string `json:"id"`
		Name  string `json:"name"`
		Value string `json:"value"`
	}
	if err := c.do(ctx, http.MethodPost, c.accountPath("/tokens"), body, &resp); err != nil {
		return nil, err
	}
	if resp.Value == "" {
		return nil, fmt.Errorf("cfapi: r2 token create returned empty token value")
	}
	sum := sha256.Sum256([]byte(resp.Value))
	return &R2APIToken{
		ID:              resp.ID,
		Name:            resp.Name,
		AccessKeyID:     resp.ID,
		SecretAccessKey: hex.EncodeToString(sum[:]),
	}, nil
}

// r2APITokenListItem is the lightweight shape returned by the list call.
// Lacks the secret — used only for "does a token with our name already
// exist?" idempotency checks.
type r2APITokenListItem struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// ListR2APITokens returns every account-scoped API token. CF's response
// is paginated but for the polaris-email use case (one token per logs
// bucket, a handful at most) the default first page is sufficient.
func (c *Client) ListR2APITokens(ctx context.Context) ([]r2APITokenListItem, error) {
	var resp struct {
		Result []r2APITokenListItem `json:"-"`
	}
	// The wrapping {success, result, errors, messages} envelope is
	// handled by Client.do — we receive `result` directly into the
	// passed-in struct's slice field via a sibling alias.
	var raw []r2APITokenListItem
	if err := c.do(ctx, http.MethodGet, c.accountPath("/tokens"), nil, &raw); err != nil {
		return nil, err
	}
	resp.Result = raw
	return resp.Result, nil
}

// FindR2APITokenByName returns the token with the given name, or nil if
// no match. Convenience wrapper around ListR2APITokens.
func (c *Client) FindR2APITokenByName(ctx context.Context, name string) (*r2APITokenListItem, error) {
	tokens, err := c.ListR2APITokens(ctx)
	if err != nil {
		return nil, err
	}
	for i, t := range tokens {
		if t.Name == name {
			return &tokens[i], nil
		}
	}
	return nil, nil
}

// DeleteR2APIToken removes a token by ID. Used when state has lost the
// secret and we need to re-create — CF refuses to mint two tokens with
// the same name in the same account.
func (c *Client) DeleteR2APIToken(ctx context.Context, id string) error {
	if id == "" {
		return fmt.Errorf("cfapi: r2 token id required")
	}
	return c.do(ctx, http.MethodDelete, c.accountPath("/tokens/"+url.PathEscape(id)), nil, nil)
}
