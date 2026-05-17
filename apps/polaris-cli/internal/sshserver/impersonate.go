// HTTP-layer impersonation: wraps the bootstrap client's transport so
// every outbound request carries `X-Polaris-On-Behalf-Of: operator:<id>`.
//
// We don't modify polaris-sdk-go itself — the client.Client struct's
// HTTPClient is per-instance, so per-session impersonation is achieved by
// giving each session a wrapped *http.Client.
package sshserver

import (
	"net/http"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
)

type oboTransport struct {
	wrapped    http.RoundTripper
	operatorID string
}

func (t *oboTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	// Clone the request so we don't mutate the caller's headers.
	r := req.Clone(req.Context())
	r.Header.Set("X-Polaris-On-Behalf-Of", "operator:"+t.operatorID)
	return t.wrapped.RoundTrip(r)
}

func withImpersonation(c *client.Client, operatorID string) *http.Client {
	base := c.HTTPClient
	if base == nil {
		base = http.DefaultClient
	}
	rt := base.Transport
	if rt == nil {
		rt = http.DefaultTransport
	}
	return &http.Client{
		Transport: &oboTransport{wrapped: rt, operatorID: operatorID},
		Timeout:   base.Timeout,
	}
}
