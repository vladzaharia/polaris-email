package webhook

import (
	"context"
	"fmt"
	"log"
	"net/url"
	"strings"

	polarissdk "github.com/polaris-email/polaris-sdk-go"
)

// Bootstrap registers (or reuses) a webhook subscription pointing at this
// bridge for every mailbox it serves. Idempotent: skips creation if a
// subscription already targets the same URL.
//
// `publicURL` is the externally-reachable origin of this bridge — Tailnet
// MagicDNS hostname in mode 1, BRIDGE_PUBLIC_URL in mode 2.
type Bootstrap struct {
	Client    *polarissdk.Client
	PublicURL string
	Path      string
}

// Result is one entry returned from Bootstrap.Run. Secret is set only on
// freshly-issued subscriptions — reused subscriptions do not re-leak the
// secret (polaris only returns it at creation time). Bridges that lose
// the secret must rotate via the admin API.
type Result struct {
	MailboxID string
	SubID     string
	Secret    string
	Reused    bool
}

// Run registers webhook subscriptions for each mailbox.
func (b *Bootstrap) Run(ctx context.Context, mailboxes []string) ([]Result, error) {
	if b.PublicURL == "" {
		return nil, fmt.Errorf("webhook bootstrap: PublicURL required")
	}
	target, err := url.JoinPath(b.PublicURL, b.Path)
	if err != nil {
		return nil, err
	}
	kind := "external"
	if strings.HasSuffix(strings.Split(strings.TrimPrefix(strings.TrimPrefix(b.PublicURL, "https://"), "http://"), "/")[0], ".ts.net") {
		kind = "tailnet"
	}

	var out []Result
	for _, mb := range mailboxes {
		existing, err := b.Client.ListWebhookSubs(ctx, mb)
		if err != nil {
			log.Printf("webhook bootstrap: list(%s): %v", mb, err)
			continue
		}
		reused := false
		for _, e := range existing {
			if e.URL == target && e.DisabledAt == "" {
				out = append(out, Result{MailboxID: mb, SubID: e.ID, Reused: true})
				reused = true
				break
			}
		}
		if reused {
			continue
		}
		resp, err := b.Client.CreateWebhookSub(ctx, polarissdk.CreateWebhookSubRequest{
			MailboxID: mb,
			URL:       target,
			Kind:      kind,
			Events:    []string{"message.received"},
		})
		if err != nil {
			log.Printf("webhook bootstrap: create(%s): %v", mb, err)
			continue
		}
		out = append(out, Result{MailboxID: mb, SubID: resp.ID, Secret: resp.Secret})
	}
	return out, nil
}

// FirstSecret returns the first non-empty secret from a slice of bootstrap
// results, or nil if every result was either reused (no secret returned) or
// empty. main.go uses this to seed the Handler's HMAC secret on bridges
// that serve a single mailbox; multi-mailbox deployments will need a
// per-subscription secret map (none of the current deployments have
// multiple subs feeding one bridge, so the single-secret model holds).
func FirstSecret(results []Result) []byte {
	for _, r := range results {
		if r.Secret != "" {
			return []byte(r.Secret)
		}
	}
	return nil
}
