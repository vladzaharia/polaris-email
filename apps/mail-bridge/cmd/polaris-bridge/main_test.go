package main

import (
	"strings"
	"testing"
)

// TestValidatePublicWebhookURL covers Phase 4b.4: when the webhook
// receiver is enabled the bridge must refuse to start with an empty,
// loopback, or localhost BRIDGE_PUBLIC_URL — polaris cannot reach those
// hosts and would silently queue undelivered events.
func TestValidatePublicWebhookURL(t *testing.T) {
	cases := []struct {
		name    string
		url     string
		wantErr bool
		matches string // substring expected in error message when wantErr
	}{
		{"empty", "", true, "must be set"},
		{"https-localhost", "https://localhost", true, "loopback"},
		{"http-localhost-port", "http://localhost:8080", true, "loopback"},
		{"loopback-v4", "https://127.0.0.1", true, "loopback"},
		{"loopback-v6", "https://[::1]:8080", true, "loopback"},
		{"loopback-v6-bare", "https://::1/path", true, "loopback"},
		{"valid-fqdn", "https://mail.example.com", false, ""},
		{"valid-tailnet", "https://polaris-mail-us-east.tailnet.ts.net", false, ""},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			err := validatePublicWebhookURL(c.url)
			if (err != nil) != c.wantErr {
				t.Fatalf("validatePublicWebhookURL(%q) err = %v, wantErr=%v", c.url, err, c.wantErr)
			}
			if c.wantErr && c.matches != "" {
				if !strings.Contains(err.Error(), c.matches) {
					t.Fatalf("error %q missing substring %q", err.Error(), c.matches)
				}
			}
		})
	}
}
