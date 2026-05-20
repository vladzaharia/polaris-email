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
	LocationHint string // optional region code, lowercase per CF docs: "wnam", "enam", "weur", "eeur", "apac", "oc"
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

// DeleteBucket removes an R2 bucket. The bucket must be empty (CF
// returns an error otherwise — caller is responsible for emptying it
// first; this matches CF's own dashboard UX). 404 is treated as
// success.
func (c *Client) DeleteBucket(ctx context.Context, name, jurisdiction string) error {
	if name == "" {
		return fmt.Errorf("cfapi: R2 bucket name required")
	}
	hdrs := map[string]string{}
	if jurisdiction != "" {
		hdrs["cf-r2-jurisdiction"] = jurisdiction
	}
	err := c.doWithHeaders(ctx, http.MethodDelete, c.accountPath("/r2/buckets/"+url.PathEscape(name)), hdrs, nil, nil)
	if err == nil || IsNotFound(err) {
		return nil
	}
	return err
}

// ObjectLockCondition picks the retention shape for an ObjectLockRule.
// CF R2 supports three condition types:
//
//   - "Age"        — MaxAgeSeconds is required; objects are locked for
//     that many seconds after creation.
//   - "Date"       — Date (RFC 3339) is required; objects are locked
//     until that absolute timestamp.
//   - "Indefinite" — no extra fields; objects are locked until the rule
//     is removed.
type ObjectLockCondition struct {
	Type          string `json:"type"`
	MaxAgeSeconds int    `json:"maxAgeSeconds,omitempty"`
	Date          string `json:"date,omitempty"`
}

// ObjectLockRule is one entry in an R2 bucket-lock configuration.
// polaris-email uses an Age rule with 90 days (7,776,000 s) on the
// message-body archive bucket. Prefix scopes the rule to a key prefix;
// empty means the whole bucket.
type ObjectLockRule struct {
	ID        string              `json:"id"`
	Enabled   bool                `json:"enabled"`
	Prefix    string              `json:"prefix,omitempty"`
	Condition ObjectLockCondition `json:"condition"`
}

// AddObjectLockRule sets the bucket-lock configuration on the named
// bucket to a single rule. CF's PUT semantics on /lock are
// full-replacement, so re-runs are idempotent — the same rule overwrites
// itself.
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
	return c.doWithHeaders(ctx, http.MethodPut, c.accountPath("/r2/buckets/"+url.PathEscape(bucket)+"/lock"), hdrs, body, nil)
}

// R2CustomDomain is the body shape for `POST /accounts/{id}/r2/buckets/{name}/domains/custom`.
// Domain is the fully-qualified hostname (e.g. r2.mail.plrs.im). The
// zone the hostname lives under must already exist in the same CF
// account; CF auto-creates the proxied CNAME and provisions the TLS cert.
//
// ZoneID is REQUIRED by CF — leave empty and AttachR2CustomDomain will
// auto-discover by walking the host's labels against the account's
// zones (needs Zone:Read token scope).
//
// MinTLS defaults to "1.2" when empty.
type R2CustomDomain struct {
	Domain  string `json:"domain"`
	Enabled bool   `json:"enabled"`
	ZoneID  string `json:"zoneId"`
	MinTLS  string `json:"minTLS,omitempty"`
}

// AttachR2CustomDomain binds a custom domain to the named R2 bucket via
// `POST /r2/buckets/{name}/domains/custom`. Idempotent: if the binding
// already exists, the call is a no-op (the existing binding is adopted).
//
// When opts.ZoneID is empty, the zone is auto-discovered via
// FindZoneIDForHost. CF rejects the request as "JSON not well formed"
// (cf code 10040) if zoneId is missing — that's not a parse error, just
// a required-field validation surfaced through the JSON validator.
func (c *Client) AttachR2CustomDomain(ctx context.Context, bucket, jurisdiction string, opts R2CustomDomain) error {
	if bucket == "" {
		return fmt.Errorf("cfapi: bucket name required")
	}
	if opts.Domain == "" {
		return fmt.Errorf("cfapi: custom domain required")
	}
	if opts.MinTLS == "" {
		opts.MinTLS = "1.2"
	}
	if opts.ZoneID == "" {
		id, err := c.FindZoneIDForHost(ctx, opts.Domain)
		if err != nil {
			return fmt.Errorf("resolve zone for %q: %w", opts.Domain, err)
		}
		opts.ZoneID = id
	}
	hdrs := map[string]string{}
	if jurisdiction != "" {
		hdrs["cf-r2-jurisdiction"] = jurisdiction
	}
	err := c.doWithHeaders(ctx, http.MethodPost,
		c.accountPath("/r2/buckets/"+url.PathEscape(bucket)+"/domains/custom"),
		hdrs, opts, nil)
	if err == nil {
		return nil
	}
	if IsAlreadyExists(err) {
		return nil
	}
	return err
}

// AddLifecycleExpiryRule applies an "expire after N days" lifecycle
// rule to the named bucket. Used for buckets that don't need Object
// Lock retention but should age-out their contents (e.g. Logpush logs,
// D1 backups). Replaces any existing lifecycle rules — CF's PUT
// semantics on `/lifecycle` are full-replacement, not append.
//
// days must be > 0; the rule deletes objects whose age exceeds it.
// prefix scopes the rule to keys with the given prefix; empty string
// applies it to the whole bucket.
func (c *Client) AddLifecycleExpiryRule(ctx context.Context, bucket, jurisdiction, prefix string, days int) error {
	if bucket == "" {
		return fmt.Errorf("cfapi: bucket name required")
	}
	if days <= 0 {
		return fmt.Errorf("cfapi: lifecycle expiry days must be > 0, got %d", days)
	}
	hdrs := map[string]string{}
	if jurisdiction != "" {
		hdrs["cf-r2-jurisdiction"] = jurisdiction
	}
	// CF lifecycle rule shape: `conditions.prefix` scopes the rule;
	// `deleteObjectsTransition.condition` chooses age vs. date — we use
	// age in seconds (R2's documented unit for the `Age` type).
	rule := map[string]any{
		"id":      "polaris-email-expiry",
		"enabled": true,
		"conditions": map[string]any{
			"prefix": prefix,
		},
		"deleteObjectsTransition": map[string]any{
			"condition": map[string]any{
				"type":             "Age",
				"maxAge":           days * 86400, // seconds
			},
		},
	}
	body := map[string]any{
		"rules": []map[string]any{rule},
	}
	return c.doWithHeaders(ctx, http.MethodPut, c.accountPath("/r2/buckets/"+url.PathEscape(bucket)+"/lifecycle"), hdrs, body, nil)
}
