// Package forwarder posts canonicalized RFC822 messages to the Polaris API.
package forwarder

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/vladzaharia/polaris-email/apps/submission-daemon/internal/sign"
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

// Forwarder posts to /v1/send/raw.
type Forwarder struct {
	cfg Config
}

// New creates a Forwarder.
func New(cfg Config) *Forwarder {
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = &http.Client{Timeout: 60 * time.Second}
	}
	return &Forwarder{cfg: cfg}
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

type sendBody struct {
	EnvelopeFrom     string   `json:"envelope_from"`
	EnvelopeTo       []string `json:"envelope_to"`
	RFC822B64        string   `json:"rfc822_b64"`
	DaemonID         string   `json:"daemon_id"`
	SubmissionID     string   `json:"submission_id"`
	ClientIP         string   `json:"client_ip"`
	ReceivedAtDaemon string   `json:"received_at_daemon"`
}

// Forward posts the request and returns a typed result.
func (f *Forwarder) Forward(ctx context.Context, in ForwardRequest) (*ForwardResult, error) {
	body := sendBody{
		EnvelopeFrom:     in.EnvelopeFrom,
		EnvelopeTo:       in.EnvelopeTo,
		RFC822B64:        base64.StdEncoding.EncodeToString(in.RFC822),
		DaemonID:         f.cfg.DaemonID,
		SubmissionID:     in.SubmissionID,
		ClientIP:         in.ClientIP,
		ReceivedAtDaemon: in.ReceivedAtDaemon.UTC().Format(time.RFC3339Nano),
	}
	raw, err := json.Marshal(&body)
	if err != nil {
		return nil, err
	}

	const path = "/v1/send/raw"
	req, err := http.NewRequestWithContext(ctx, "POST", f.cfg.APIURL+path, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("CF-Access-Client-Id", f.cfg.AccessClientID)
	req.Header.Set("CF-Access-Client-Secret", f.cfg.AccessClientSecret)
	req.Header.Set("X-Polaris-Daemon-Id", f.cfg.DaemonID)
	req.Header.Set("X-Polaris-Submission-Id", in.SubmissionID)
	sign.Request(req, "POST", path, raw, f.cfg.HMACKey)

	resp, err := f.cfg.HTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)

	res := &ForwardResult{StatusCode: resp.StatusCode, Body: respBody}
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

