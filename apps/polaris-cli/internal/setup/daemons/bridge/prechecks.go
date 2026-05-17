package bridge

import (
	"context"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/platform"
)

// PreCheckStatus is the result of one precheck.
type PreCheckStatus string

const (
	StatusPass PreCheckStatus = "pass"
	StatusFail PreCheckStatus = "fail"
	StatusSkip PreCheckStatus = "skip" // not applicable for this input
	StatusWarn PreCheckStatus = "warn" // advisory; does not block
)

// PreCheckResult is one entry in the precheck report.
type PreCheckResult struct {
	Name    string         `json:"name"`
	Status  PreCheckStatus `json:"status"`
	Message string         `json:"message,omitempty"`
}

// PreCheckDeps lets tests inject doubles for docker / http.
type PreCheckDeps struct {
	Docker     *platform.Docker
	HTTPClient *http.Client
}

// DefaultDeps returns the production wiring: a real Docker and a 5s
// HTTP client.
func DefaultDeps() *PreCheckDeps {
	return &PreCheckDeps{
		Docker:     platform.NewDocker(),
		HTTPClient: &http.Client{Timeout: 5 * time.Second},
	}
}

// PreFlight runs every applicable precheck for the supplied input and
// returns the report. The caller decides whether any failures abort
// the wizard.
func PreFlight(ctx context.Context, in *BridgeSetupInput, deps *PreCheckDeps) []PreCheckResult {
	if deps == nil {
		deps = DefaultDeps()
	}
	results := []PreCheckResult{
		checkDirectoryPerms(in),
		checkDocker(ctx, deps.Docker),
		checkComposeVersion(ctx, deps.Docker),
		checkPortFree(ctx, "smtps", in.SMTPSPort),
		checkPortFree(ctx, "imap", in.IMAPPort),
		checkPortFree(ctx, "webhook", in.WebhookPort),
		checkPolarisAPIReachable(ctx, in.PolarisAPIURL, deps.HTTPClient),
		checkPublicURLNonLoopback(in.PublicURL),
	}
	if in.TLSSource == TLSMounted {
		results = append(results, checkMountedTLSReadable(in.TLSDir))
	}
	return results
}

func checkDirectoryPerms(in *BridgeSetupInput) PreCheckResult {
	if in.Dir == "" {
		return PreCheckResult{Name: "dir-perms", Status: StatusSkip}
	}
	if err := platform.RejectWorldReadableDir(in.Dir); err != nil {
		return PreCheckResult{Name: "dir-perms", Status: StatusFail, Message: err.Error()}
	}
	return PreCheckResult{Name: "dir-perms", Status: StatusPass, Message: fmt.Sprintf("%s is not world-readable", in.Dir)}
}

func checkDocker(ctx context.Context, d *platform.Docker) PreCheckResult {
	v, err := d.Info(ctx)
	if err != nil {
		return PreCheckResult{Name: "docker-info", Status: StatusFail, Message: "docker daemon unreachable: " + err.Error()}
	}
	return PreCheckResult{Name: "docker-info", Status: StatusPass, Message: "docker server " + v}
}

func checkComposeVersion(ctx context.Context, d *platform.Docker) PreCheckResult {
	maj, min, _, err := d.ComposeVersion(ctx)
	if err != nil {
		return PreCheckResult{Name: "compose-version", Status: StatusFail, Message: err.Error()}
	}
	if maj < 2 || (maj == 2 && min < 20) {
		return PreCheckResult{Name: "compose-version", Status: StatusFail,
			Message: fmt.Sprintf("compose v%d.%d < required 2.20", maj, min)}
	}
	return PreCheckResult{Name: "compose-version", Status: StatusPass,
		Message: fmt.Sprintf("docker compose v%d.%d", maj, min)}
}

func checkPortFree(ctx context.Context, label string, port int) PreCheckResult {
	ok, err := platform.IsPortFree(ctx, port)
	if err != nil {
		return PreCheckResult{Name: "port-" + label, Status: StatusFail, Message: err.Error()}
	}
	if !ok {
		return PreCheckResult{Name: "port-" + label, Status: StatusFail,
			Message: fmt.Sprintf("port %d is already bound — pick a different host port", port)}
	}
	return PreCheckResult{Name: "port-" + label, Status: StatusPass,
		Message: fmt.Sprintf("port %d is free", port)}
}

func checkPolarisAPIReachable(ctx context.Context, baseURL string, client *http.Client) PreCheckResult {
	if baseURL == "" {
		return PreCheckResult{Name: "polaris-api", Status: StatusSkip, Message: "no api url configured"}
	}
	req, err := http.NewRequestWithContext(ctx, "GET", strings.TrimRight(baseURL, "/")+"/healthz", nil)
	if err != nil {
		return PreCheckResult{Name: "polaris-api", Status: StatusFail, Message: err.Error()}
	}
	resp, err := client.Do(req)
	if err != nil {
		return PreCheckResult{Name: "polaris-api", Status: StatusFail, Message: err.Error()}
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode >= 200 && resp.StatusCode < 500 {
		// /healthz may legitimately return 401 (admin scope) — anything
		// that comes back from the control plane proves reachability.
		return PreCheckResult{Name: "polaris-api", Status: StatusPass,
			Message: fmt.Sprintf("GET /healthz → %d", resp.StatusCode)}
	}
	return PreCheckResult{Name: "polaris-api", Status: StatusFail,
		Message: fmt.Sprintf("GET /healthz → %d", resp.StatusCode)}
}

func checkPublicURLNonLoopback(u string) PreCheckResult {
	if u == "" {
		return PreCheckResult{Name: "public-url", Status: StatusSkip}
	}
	if strings.Contains(u, "127.0.0.1") || strings.Contains(u, "localhost") || strings.Contains(u, "::1") {
		return PreCheckResult{Name: "public-url", Status: StatusFail,
			Message: "public_url is a loopback address; polaris fanout cannot reach it"}
	}
	return PreCheckResult{Name: "public-url", Status: StatusPass, Message: u}
}

func checkMountedTLSReadable(dir string) PreCheckResult {
	if dir == "" {
		return PreCheckResult{Name: "tls-pem", Status: StatusSkip}
	}
	fullchain := filepath.Join(dir, "fullchain.pem")
	privkey := filepath.Join(dir, "privkey.pem")
	for _, p := range []string{fullchain, privkey} {
		info, err := os.Stat(p)
		if err != nil {
			return PreCheckResult{Name: "tls-pem", Status: StatusWarn,
				Message: fmt.Sprintf("%s not present yet — operator must mount before `docker compose up`", p)}
		}
		if info.IsDir() {
			return PreCheckResult{Name: "tls-pem", Status: StatusFail,
				Message: fmt.Sprintf("%s is a directory", p)}
		}
	}
	// Best-effort cert expiry check on fullchain.
	pemBytes, err := os.ReadFile(fullchain)
	if err != nil {
		return PreCheckResult{Name: "tls-pem", Status: StatusWarn, Message: err.Error()}
	}
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return PreCheckResult{Name: "tls-pem", Status: StatusWarn, Message: "could not pem-decode fullchain.pem"}
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return PreCheckResult{Name: "tls-pem", Status: StatusWarn, Message: err.Error()}
	}
	if time.Until(cert.NotAfter) < 24*time.Hour {
		return PreCheckResult{Name: "tls-pem", Status: StatusFail,
			Message: fmt.Sprintf("fullchain.pem expires at %s (within 24h)", cert.NotAfter.Format(time.RFC3339))}
	}
	return PreCheckResult{Name: "tls-pem", Status: StatusPass,
		Message: fmt.Sprintf("fullchain.pem valid until %s", cert.NotAfter.Format(time.RFC3339))}
}

// ValidateTailscaleAuthKey is a shape-only check (no API call) — the
// auth-key is single-use so we can't validate it without burning it.
// tskey-auth-... is the canonical prefix.
func ValidateTailscaleAuthKey(key string) error {
	if !strings.HasPrefix(key, "tskey-auth-") {
		return fmt.Errorf("tailscale auth-key must start with 'tskey-auth-'")
	}
	if len(key) < 30 {
		return fmt.Errorf("tailscale auth-key looks truncated")
	}
	return nil
}

// VerifyCFDNSToken hits the Cloudflare token-verification endpoint. The
// lego workflow needs Zone:Read + Zone:DNS:Edit on the bridge's zone;
// we only verify the token is live here — scope mismatches surface as
// 4xx during a real cert issue.
func VerifyCFDNSToken(ctx context.Context, token string, client *http.Client) error {
	if token == "" {
		return fmt.Errorf("CF_DNS_API_TOKEN is empty")
	}
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	req, err := http.NewRequestWithContext(ctx, "GET", "https://api.cloudflare.com/client/v4/user/tokens/verify", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("cf token verify: HTTP %d", resp.StatusCode)
	}
	return nil
}
