package bridge

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ProbeStatus is the result of one post-up health probe.
type ProbeStatus string

const (
	ProbePass ProbeStatus = "pass"
	ProbeFail ProbeStatus = "fail"
	ProbeSkip ProbeStatus = "skip"
)

// ProbeResult is one entry in the post-up health report.
type ProbeResult struct {
	Name    string      `json:"name"`
	Status  ProbeStatus `json:"status"`
	Message string      `json:"message,omitempty"`
}

// ProbeDeps lets tests inject doubles.
type ProbeDeps struct {
	HTTPClient *http.Client
	// LookupClient is the control-plane client used to verify
	// `last_seen_at` for the bridge. Optional; pass a function that
	// hits /v1/admin/bridges/lookup?name=<name>.
	LookupClient BridgeLookup
}

// BridgeLookup is the slice of the polaris admin client the probe set
// needs. Tests substitute a stub; production wires `client.Do` from
// internal/client.
type BridgeLookup interface {
	Lookup(ctx context.Context, name string) (*LookupResult, error)
}

// LookupResult mirrors the shape of `GET /v1/admin/bridges/lookup`
// without taking a dep on internal/client (which would pull cobra in).
type LookupResult struct {
	Name       string     `json:"name"`
	LastSeenAt *time.Time `json:"last_seen_at,omitempty"`
}

// Probe runs the health probes for the supplied input.
func Probe(ctx context.Context, in *BridgeSetupInput, deps *ProbeDeps) []ProbeResult {
	if deps == nil {
		deps = &ProbeDeps{HTTPClient: &http.Client{Timeout: 5 * time.Second}}
	}
	hostname := tlsProbeHost(in)
	results := []ProbeResult{
		probeTLS(ctx, "smtps", hostname, in.SMTPSPort),
		probeIMAPCapability(ctx, hostname, in.IMAPPort),
		probeHTTP(ctx, "webhook", fmt.Sprintf("http://%s:%d/healthz", hostname, in.WebhookPort), deps.HTTPClient),
	}
	if deps.LookupClient != nil {
		results = append(results, probeLastSeen(ctx, in.BridgeName, deps.LookupClient))
	} else {
		results = append(results, ProbeResult{Name: "bridge-last-seen", Status: ProbeSkip,
			Message: "no lookup client wired; skip"})
	}
	return results
}

// tlsProbeHost picks the loopback for local mode (containers expose
// their published ports to the host), or the bridge's FQDN for
// tailscale mode (the listener lives inside the sidecar's namespace).
func tlsProbeHost(in *BridgeSetupInput) string {
	if in.Mode == ModeTailscale {
		return in.FQDN
	}
	return "127.0.0.1"
}

func probeTLS(ctx context.Context, label, host string, port int) ProbeResult {
	d := &tls.Dialer{
		NetDialer: &net.Dialer{Timeout: 5 * time.Second},
		Config: &tls.Config{
			// We are not authenticating the bridge; we only want to
			// confirm a TLS handshake completes. Operators care that
			// the listener answered TLS, not that the cert chains to
			// a CA they trust.
			InsecureSkipVerify: true, //nolint:gosec
			MinVersion:         tls.VersionTLS12,
		},
	}
	conn, err := d.DialContext(ctx, "tcp", fmt.Sprintf("%s:%d", host, port))
	if err != nil {
		return ProbeResult{Name: "tls-" + label, Status: ProbeFail, Message: err.Error()}
	}
	_ = conn.Close()
	return ProbeResult{Name: "tls-" + label, Status: ProbePass,
		Message: fmt.Sprintf("TLS handshake ok on %s:%d", host, port)}
}

// probeIMAPCapability completes a TLS handshake on port 993 and reads
// the IMAP server greeting. Real IMAP CAPABILITY round-trip is overkill
// for a smoke check — receiving "* OK" with "IMAP" in the banner is
// what matters.
func probeIMAPCapability(ctx context.Context, host string, port int) ProbeResult {
	d := &tls.Dialer{
		NetDialer: &net.Dialer{Timeout: 5 * time.Second},
		Config: &tls.Config{InsecureSkipVerify: true, MinVersion: tls.VersionTLS12}, //nolint:gosec
	}
	conn, err := d.DialContext(ctx, "tcp", fmt.Sprintf("%s:%d", host, port))
	if err != nil {
		return ProbeResult{Name: "imap-greeting", Status: ProbeFail, Message: err.Error()}
	}
	defer conn.Close()
	if err := conn.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return ProbeResult{Name: "imap-greeting", Status: ProbeFail, Message: err.Error()}
	}
	buf := make([]byte, 256)
	n, err := conn.Read(buf)
	if err != nil {
		return ProbeResult{Name: "imap-greeting", Status: ProbeFail, Message: err.Error()}
	}
	greeting := strings.TrimSpace(string(buf[:n]))
	if !strings.HasPrefix(greeting, "* OK") {
		return ProbeResult{Name: "imap-greeting", Status: ProbeFail,
			Message: fmt.Sprintf("unexpected greeting %q", greeting)}
	}
	return ProbeResult{Name: "imap-greeting", Status: ProbePass, Message: greeting}
}

func probeHTTP(ctx context.Context, label, target string, client *http.Client) ProbeResult {
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	req, err := http.NewRequestWithContext(ctx, "GET", target, nil)
	if err != nil {
		return ProbeResult{Name: "http-" + label, Status: ProbeFail, Message: err.Error()}
	}
	resp, err := client.Do(req)
	if err != nil {
		return ProbeResult{Name: "http-" + label, Status: ProbeFail, Message: err.Error()}
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != 200 {
		return ProbeResult{Name: "http-" + label, Status: ProbeFail,
			Message: fmt.Sprintf("GET %s → %d", target, resp.StatusCode)}
	}
	return ProbeResult{Name: "http-" + label, Status: ProbePass,
		Message: fmt.Sprintf("GET %s → %d", target, resp.StatusCode)}
}

func probeLastSeen(ctx context.Context, name string, lookup BridgeLookup) ProbeResult {
	r, err := lookup.Lookup(ctx, name)
	if err != nil {
		return ProbeResult{Name: "bridge-last-seen", Status: ProbeFail, Message: err.Error()}
	}
	if r == nil || r.LastSeenAt == nil {
		return ProbeResult{Name: "bridge-last-seen", Status: ProbeFail,
			Message: "control plane has not received a heartbeat yet"}
	}
	if time.Since(*r.LastSeenAt) > 60*time.Second {
		return ProbeResult{Name: "bridge-last-seen", Status: ProbeFail,
			Message: fmt.Sprintf("last_seen_at=%s (>60s ago)", r.LastSeenAt.Format(time.RFC3339))}
	}
	return ProbeResult{Name: "bridge-last-seen", Status: ProbePass,
		Message: "control plane saw the bridge within 60s"}
}

// HTTPBridgeLookup wraps an *http.Client + admin base URL into a
// BridgeLookup. The HMAC headers are not required for tests but real
// runs must inject them via a transport wrapper.
type HTTPBridgeLookup struct {
	BaseURL string
	Client  *http.Client
}

// Lookup hits /v1/admin/bridges/lookup?name=<name>.
func (l *HTTPBridgeLookup) Lookup(ctx context.Context, name string) (*LookupResult, error) {
	if l.Client == nil {
		return nil, errors.New("http lookup: nil client")
	}
	u := strings.TrimRight(l.BaseURL, "/") + "/v1/admin/bridges/lookup?name=" + url.QueryEscape(name)
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return nil, err
	}
	resp, err := l.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("bridges/lookup: HTTP %d", resp.StatusCode)
	}
	var out LookupResult
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return &out, nil
}
