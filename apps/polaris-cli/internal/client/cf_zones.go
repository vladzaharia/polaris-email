package client

import (
	"context"
	"fmt"
	"net/url"
)

// ListCFZones calls GET /v1/admin/cf-zones. When refresh is true, the
// `?refresh=1` query is added to bypass the 60s in-Worker cache.
func (c *Client) ListCFZones(ctx context.Context, refresh bool) (*CFZonesListResponse, error) {
	var q url.Values
	if refresh {
		q = url.Values{"refresh": []string{"1"}}
	}
	var out CFZonesListResponse
	if err := c.DoJSON(ctx, "GET", "/v1/admin/cf-zones", q, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetCFZone calls GET /v1/admin/cf-zones/:name. Always bypasses the listing
// cache server-side.
func (c *Client) GetCFZone(ctx context.Context, name string) (*ZoneDomainStatus, error) {
	if name == "" {
		return nil, fmt.Errorf("cf-zones: name is required")
	}
	path := fmt.Sprintf("/v1/admin/cf-zones/%s", url.PathEscape(name))
	var out CFZoneGetResponse
	if err := c.DoJSON(ctx, "GET", path, nil, nil, &out); err != nil {
		return nil, err
	}
	return &out.Data, nil
}

// ConfigureCFZone calls POST /v1/admin/cf-zones/:name/configure with the
// given dry-run flag and (optional) op-kinds filter. Pass dryRun=true to
// preview, false to apply. opKinds=nil applies / previews every op the
// server plans; a non-nil slice restricts to those kinds (server-side
// filter).
func (c *Client) ConfigureCFZone(ctx context.Context, name string, dryRun bool, opKinds []string) (*ZoneConfigureResult, error) {
	if name == "" {
		return nil, fmt.Errorf("cf-zones: name is required")
	}
	path := fmt.Sprintf("/v1/admin/cf-zones/%s/configure", url.PathEscape(name))
	// Always send dry_run explicitly (server defaults to true, but we want the
	// dry-run intent visible in the audit log + dry-run printed request).
	body := map[string]any{"dry_run": dryRun}
	if len(opKinds) > 0 {
		body["op_kinds"] = opKinds
	}
	var out ZoneConfigureResult
	if err := c.DoJSON(ctx, "POST", path, nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
