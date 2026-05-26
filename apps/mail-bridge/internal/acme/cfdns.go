// CF DNS A-record upsert + lookup, used by the renewer to keep the
// bridge's FQDN pointing at its current IP.
//
// We don't pull in a full Cloudflare SDK — only two API shapes are
// needed (list A records by name, create/update one) and the bridge's
// CF token already has scope to call both. Pure stdlib HTTP keeps
// this package free of external deps (the only outside import in the
// bridge is Lego itself, added for the ACME loop).

package acme

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const cfBaseURL = "https://api.cloudflare.com/client/v4"

type cfEnvelope[T any] struct {
	Success bool             `json:"success"`
	Errors  []cfErrorEntry   `json:"errors"`
	Result  json.RawMessage  `json:"result"`
	private struct{ _ bool } // suppress vet for unused-private; placeholder for future fields
}

type cfErrorEntry struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type cfDnsRecord struct {
	ID      string `json:"id"`
	Type    string `json:"type"`
	Name    string `json:"name"`
	Content string `json:"content"`
	TTL     int    `json:"ttl"`
}

// CFDnsClient is a thin, stdlib-only CF DNS API client scoped to a
// single zone. The bridge instantiates it once per renewer cycle.
type CFDnsClient struct {
	HTTPClient *http.Client
	APIToken   string
	ZoneID     string
}

func newHTTPClient() *http.Client {
	return &http.Client{Timeout: 30 * time.Second}
}

// UpsertA writes `name → ip` as an A record, creating or updating in
// place. Idempotent — calling with the same ip is a no-op (CF returns
// the existing record). TTL is 60s so a bridge IP change propagates
// quickly without thrashing CF's edge cache.
func (c *CFDnsClient) UpsertA(ctx context.Context, name, ip string) error {
	rec, err := c.findA(ctx, name)
	if err != nil {
		return err
	}
	if rec != nil && rec.Content == ip {
		return nil
	}
	body := cfDnsRecord{Type: "A", Name: name, Content: ip, TTL: 60}
	if rec != nil {
		return c.do(ctx, http.MethodPut,
			fmt.Sprintf("/zones/%s/dns_records/%s", c.ZoneID, rec.ID), body, nil)
	}
	return c.do(ctx, http.MethodPost,
		fmt.Sprintf("/zones/%s/dns_records", c.ZoneID), body, nil)
}

func (c *CFDnsClient) findA(ctx context.Context, name string) (*cfDnsRecord, error) {
	path := fmt.Sprintf("/zones/%s/dns_records?type=A&name=%s", c.ZoneID, name)
	var out []cfDnsRecord
	if err := c.do(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, nil
	}
	return &out[0], nil
}

func (c *CFDnsClient) do(ctx context.Context, method, path string, body, out any) error {
	httpClient := c.HTTPClient
	if httpClient == nil {
		httpClient = newHTTPClient()
	}
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, cfBaseURL+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.APIToken)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	rb, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	var env cfEnvelope[json.RawMessage]
	if err := json.Unmarshal(rb, &env); err != nil {
		return fmt.Errorf("cf decode %s %s: %w", method, path, err)
	}
	if !env.Success || resp.StatusCode >= 400 {
		if len(env.Errors) > 0 {
			return fmt.Errorf("cf %s %s: %d %s",
				method, path, env.Errors[0].Code, env.Errors[0].Message)
		}
		return fmt.Errorf("cf %s %s: http %d", method, path, resp.StatusCode)
	}
	if out != nil {
		if err := json.Unmarshal(env.Result, out); err != nil {
			return fmt.Errorf("cf result decode %s %s: %w", method, path, err)
		}
	}
	return nil
}
