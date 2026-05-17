package cfapi

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

// R2Bucket is the shape returned by R2's list/get endpoints.
type R2Bucket struct {
	Name         string    `json:"name"`
	CreationDate time.Time `json:"creation_date,omitempty"`
	Location     string    `json:"location,omitempty"`
	// Jurisdiction is reported by the v4 list endpoint when buckets live
	// in a non-default jurisdiction (e.g. "eu", "fedramp"). It is *not*
	// echoed for default-jurisdiction buckets.
	Jurisdiction string `json:"jurisdiction,omitempty"`
}

type r2ListResp struct {
	Buckets []R2Bucket `json:"buckets"`
}

// ListBuckets returns every R2 bucket under the account. R2 list is
// non-paginated; the response is a single envelope.
//
// When jurisdiction is non-empty the request scopes to that
// jurisdiction (via cf-r2-jurisdiction header) — callers who want every
// bucket across jurisdictions must call once per jurisdiction.
func (c *Client) ListBuckets(ctx context.Context, jurisdiction string) ([]R2Bucket, error) {
	hdrs := map[string]string{}
	if jurisdiction != "" {
		hdrs["cf-r2-jurisdiction"] = jurisdiction
	}
	var resp r2ListResp
	if err := c.doWithHeaders(ctx, http.MethodGet, c.accountPath("/r2/buckets"), hdrs, nil, &resp); err != nil {
		return nil, err
	}
	// Stamp jurisdiction onto each entry so downstream callers can
	// distinguish — CF's list response omits the field for default-
	// jurisdiction buckets.
	for i := range resp.Buckets {
		if resp.Buckets[i].Jurisdiction == "" {
			resp.Buckets[i].Jurisdiction = jurisdiction
		}
	}
	return resp.Buckets, nil
}

// GetBucket fetches a single bucket by name.
func (c *Client) GetBucket(ctx context.Context, name, jurisdiction string) (*R2Bucket, error) {
	if name == "" {
		return nil, fmt.Errorf("cfapi: R2 bucket name required")
	}
	hdrs := map[string]string{}
	if jurisdiction != "" {
		hdrs["cf-r2-jurisdiction"] = jurisdiction
	}
	var b R2Bucket
	if err := c.doWithHeaders(ctx, http.MethodGet, c.accountPath("/r2/buckets/"+url.PathEscape(name)), hdrs, nil, &b); err != nil {
		return nil, err
	}
	if b.Jurisdiction == "" {
		b.Jurisdiction = jurisdiction
	}
	return &b, nil
}

// CreateBucketInput is the typed input for CreateBucket. We use a struct
// instead of positional args so callers can add the (rare) extra fields
// without a signature change.
type CreateBucketInput struct {
	Name         string
	Jurisdiction string // "eu" for polaris-email
	LocationHint string // optional ("WEUR", "WNAM", etc.)
}

// CreateBucket creates an R2 bucket. The EU jurisdiction is set via the
// `cf-r2-jurisdiction` header (per the R2 REST docs); it cannot be
// passed in the JSON body.
//
// On 409 / already-exists, the existing bucket is fetched and returned —
// the idempotency contract.
func (c *Client) CreateBucket(ctx context.Context, in CreateBucketInput) (*R2Bucket, error) {
	if in.Name == "" {
		return nil, fmt.Errorf("cfapi: R2 bucket name required")
	}
	body := map[string]any{"name": in.Name}
	if in.LocationHint != "" {
		body["locationHint"] = in.LocationHint
	}
	hdrs := map[string]string{}
	if in.Jurisdiction != "" {
		hdrs["cf-r2-jurisdiction"] = in.Jurisdiction
	}
	var b R2Bucket
	err := c.doWithHeaders(ctx, http.MethodPost, c.accountPath("/r2/buckets"), hdrs, body, &b)
	if err == nil {
		if b.Jurisdiction == "" {
			b.Jurisdiction = in.Jurisdiction
		}
		return &b, nil
	}
	if IsAlreadyExists(err) {
		existing, gerr := c.GetBucket(ctx, in.Name, in.Jurisdiction)
		if gerr != nil {
			return nil, fmt.Errorf("cfapi: R2 %q already exists but GET failed: %w", in.Name, gerr)
		}
		return existing, nil
	}
	return nil, err
}

// ObjectLockRule applies an Object Lock retention policy to a bucket via
// the lifecycle endpoint. Hours is the COMPLIANCE-mode retention window
// (polaris-email uses ~2160h = 90 days, but the audit-anchor bucket
// receives ~61320h ≈ 7 years).
//
// PR 1 only needs the surface to exist; the heavy testing lands in PR 3
// (provision phase) which actually wires this onto polaris-mail-archive.
type ObjectLockRule struct {
	ID             string `json:"id"`
	Enabled        bool   `json:"enabled"`
	RetentionHours int    `json:"retentionHours"`
	RetentionMode  string `json:"retentionMode"`
}

// AddObjectLockRule adds (or replaces) an Object Lock retention rule on
// the named bucket.
func (c *Client) AddObjectLockRule(ctx context.Context, bucket, jurisdiction string, rule ObjectLockRule) error {
	if bucket == "" {
		return fmt.Errorf("cfapi: bucket name required")
	}
	hdrs := map[string]string{}
	if jurisdiction != "" {
		hdrs["cf-r2-jurisdiction"] = jurisdiction
	}
	body := map[string]any{
		"rules": []ObjectLockRule{rule},
	}
	return c.doWithHeaders(ctx, http.MethodPut, c.accountPath("/r2/buckets/"+url.PathEscape(bucket)+"/lifecycle"), hdrs, body, nil)
}
