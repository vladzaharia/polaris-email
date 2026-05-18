package cfapi

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
)

// R2APIToken is the response shape from POST /accounts/{id}/r2/tokens.
// The Value (secret) and AccessKeyID are returned EXACTLY ONCE at
// creation time — CF doesn't echo them on subsequent GETs. Persist them
// immediately or you'll have to delete and re-create the token.
type R2APIToken struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Permission      string `json:"permission"`
	AccessKeyID     string `json:"accessKeyId"`
	SecretAccessKey string `json:"secretAccessKey"`
}

// r2APITokenListItem is the GET /accounts/{id}/r2/tokens shape. Lacks
// the secret — used only for idempotency checks (does a token with our
// name already exist?).
type r2APITokenListItem struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Permission string `json:"permission"`
}

type r2APITokenListResp struct {
	Tokens []r2APITokenListItem `json:"tokens"`
}

// CreateR2APITokenInput configures the bucket-scoped API token.
//
// Name identifies the token (operator-visible in the CF dashboard).
// Bucket is the R2 bucket the token can read/write — scope is enforced
// server-side by CF.
// Permission is one of "admin-read-write", "admin-read-only",
// "object-read-write", "object-read-only". For Logpush we use
// object-read-write because Logpush only ever PUTs new objects + we
// don't want list/delete permissions on the bucket.
type CreateR2APITokenInput struct {
	Name        string
	Bucket      string
	Permission  string // defaults to "object-read-write"
}

// CreateR2APIToken creates a new R2 API token scoped to a single bucket
// and returns the credentials. The caller MUST persist Token.Value +
// Token.AccessKeyID — CF will never return them again.
func (c *Client) CreateR2APIToken(ctx context.Context, in CreateR2APITokenInput) (*R2APIToken, error) {
	if in.Name == "" {
		return nil, fmt.Errorf("cfapi: r2 token name required")
	}
	if in.Bucket == "" {
		return nil, fmt.Errorf("cfapi: r2 token bucket required")
	}
	permission := in.Permission
	if permission == "" {
		permission = "object-read-write"
	}
	// The Cloudflare API expects bucket scope as a list of objects with
	// `name` + `permission`. One entry per bucket; we're single-bucket
	// per token.
	body := map[string]any{
		"name":       in.Name,
		"permission": permission,
		"buckets": []map[string]any{
			{"name": in.Bucket, "permission": permission},
		},
	}
	var resp R2APIToken
	if err := c.do(ctx, http.MethodPost, c.accountPath("/r2/tokens"), body, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// ListR2APITokens returns the metadata of every R2 API token on the
// account. Used by the provision step to detect existing tokens by
// name before creating duplicates. Note: this DOES NOT return secrets
// — the SecretAccessKey + AccessKeyID fields will be empty.
func (c *Client) ListR2APITokens(ctx context.Context) ([]r2APITokenListItem, error) {
	var resp r2APITokenListResp
	if err := c.do(ctx, http.MethodGet, c.accountPath("/r2/tokens"), nil, &resp); err != nil {
		return nil, err
	}
	return resp.Tokens, nil
}

// FindR2APITokenByName returns the token with the given name, or nil
// if no match. Convenience wrapper around ListR2APITokens.
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

// DeleteR2APIToken removes a token by ID. Used when state has lost
// the secret and we need to re-create — CF refuses to mint two tokens
// with the same name.
func (c *Client) DeleteR2APIToken(ctx context.Context, id string) error {
	if id == "" {
		return fmt.Errorf("cfapi: r2 token id required")
	}
	return c.do(ctx, http.MethodDelete, c.accountPath("/r2/tokens/"+url.PathEscape(id)), nil, nil)
}
