// Package forwarder posts canonicalized RFC822 messages to the Polaris API.
//
// Phase F migration: this used to POST a JSON body to /v1/send/raw with a
// custom 5-line HMAC. It now POSTs raw RFC822 bytes to /v1/messages with
// `Content-Type: message/rfc822` via the shared polaris-sdk-go client, which
// performs the canonical 7-line HMAC over the body bytes.
package forwarder

import (
	"context"
	"net/http"
	"time"

	polarissdk "github.com/polaris-email/polaris-sdk-go"
)

// Config carries the fixed bits each Forward call needs.
type Config struct {
	APIURL             string
	HMACKey            []byte
	DaemonID           string
	AccessClientID     string
	AccessClientSecret string
	HTTPClient         *http.Client
}

// Forwarder posts to POST /v1/messages (message/rfc822).
type Forwarder struct {
	cfg    Config
	client *polarissdk.Client
}

// New creates a Forwarder.
func New(cfg Config) *Forwarder {
	httpClient := cfg.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 60 * time.Second}
	}
	c := polarissdk.NewClient(cfg.APIURL)
	c.HTTPClient = httpClient
	c.DaemonID = cfg.DaemonID
	c.DaemonSecret = cfg.HMACKey
	c.ExtraHeaders = map[string]string{
		"CF-Access-Client-Id":     cfg.AccessClientID,
		"CF-Access-Client-Secret": cfg.AccessClientSecret,
	}
	return &Forwarder{cfg: cfg, client: c}
}

// ForwardRequest is the input to Forward.
type ForwardRequest struct {
	EnvelopeFrom     string
	EnvelopeTo       []string
	RFC822           []byte
	SubmissionID     string
	ClientIP         string
	ReceivedAtDaemon time.Time
}

// ForwardResult is the typed response.
type ForwardResult struct {
	StatusCode int
	Body       []byte
	// Category: "ok" (2xx), "transient" (4xx soft), "permanent" (4xx hard / 5xx).
	Category string
}

// Forward posts the request and returns a typed result.
func (f *Forwarder) Forward(ctx context.Context, in ForwardRequest) (*ForwardResult, error) {
	extra := map[string]string{
		"X-Polaris-Submission-Id":   in.SubmissionID,
		"X-Polaris-Client-IP":       in.ClientIP,
		"X-Polaris-Received-Daemon": in.ReceivedAtDaemon.UTC().Format(time.RFC3339Nano),
	}
	resp, body, err := f.client.Do(ctx, "POST", "/v1/messages", "", in.RFC822, "message/rfc822", extra)
	if err != nil {
		return nil, err
	}
	res := &ForwardResult{StatusCode: resp.StatusCode, Body: body}
	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		res.Category = "ok"
	case resp.StatusCode == http.StatusRequestTimeout,
		resp.StatusCode == http.StatusTooManyRequests,
		resp.StatusCode >= 500:
		res.Category = "transient"
	default:
		res.Category = "permanent"
	}
	return res, nil
}
