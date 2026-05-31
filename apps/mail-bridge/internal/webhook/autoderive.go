package webhook

import (
	"fmt"
	"net"
	"strings"
)

// AutoDeriveInput is the set of hints the bridge has about where it's
// reachable from polaris's egress. The deriver picks the most-specific
// non-empty option (tailnet → fqdn → IP).
type AutoDeriveInput struct {
	// TailnetFQDN is the MagicDNS hostname the api worker returned
	// from /v1/bridge/config (e.g. `greenwood-mail.tailnet.ts.net`).
	// Empty when this bridge isn't on a tailnet OR the api worker
	// doesn't know the tailnet's MagicDNS domain.
	TailnetFQDN string
	// FQDN is the public DNS name (`<bridge-name>.mail.plrs.im`).
	// Always non-empty in production; the bridge keeps an A record
	// pointing at its IP via the embedded ACME loop.
	FQDN string
	// IP is the bridge's local listen IP (auto-detected via
	// acme.DetectBridgeIP). Used as a last-resort fallback when
	// nothing else resolves — operator probably wants this only when
	// the bridge + polaris share a flat private network.
	IP string
	// ListenPort is the local port the receiver listens on (default
	// 8080). Appended to whatever host wins.
	ListenPort int
	// Scheme is "http" or "https". Tailnet hosts default to http
	// (MagicDNS doesn't auto-issue TLS certs the way mail.plrs.im
	// does), public FQDN defaults to https.
	Scheme string
	// Path is the receiver mount path; defaults to
	// "/internal/webhook/message-received" when empty.
	Path string
}

// AutoDeriveURL picks the best webhook URL from the available hints.
// Priority order: TailnetFQDN → FQDN → IP. The first non-empty option
// wins; if all are empty the function returns the empty string and the
// caller should fail-closed (webhook receiver stays bootstrap-pending).
//
// Schema/port/path defaults make the common case a one-liner from the
// bridge's main loop.
func AutoDeriveURL(in AutoDeriveInput) string {
	host, isIP := pickHost(in)
	if host == "" {
		return ""
	}
	scheme := in.Scheme
	if scheme == "" {
		// Public DNS gets ACME-issued certs; tailnet hosts don't have
		// one out of the box (MagicDNS cert minting is an opt-in TS
		// feature). Default scheme accordingly.
		if isIP || host == strings.TrimSpace(in.TailnetFQDN) {
			scheme = "http"
		} else {
			scheme = "https"
		}
	}
	port := in.ListenPort
	if port == 0 {
		port = 8080
	}
	path := in.Path
	if path == "" {
		path = "/internal/webhook/message-received"
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	hostport := host
	// Suppress the explicit port when it's the scheme's default
	// (80/443) — keeps URLs canonical and avoids subtle mismatches
	// when polaris later normalizes.
	if !(scheme == "http" && port == 80) && !(scheme == "https" && port == 443) {
		hostport = fmt.Sprintf("%s:%d", host, port)
	}
	return fmt.Sprintf("%s://%s%s", scheme, hostport, path)
}

// pickHost returns the chosen host plus whether the choice was an IP
// fallback (so the caller can default scheme to http even when the IP
// was wrapped in brackets for IPv6 URL parsing).
func pickHost(in AutoDeriveInput) (host string, isIP bool) {
	if h := strings.TrimSpace(in.TailnetFQDN); h != "" {
		return h, false
	}
	if h := strings.TrimSpace(in.FQDN); h != "" {
		return h, false
	}
	if h := strings.TrimSpace(in.IP); h != "" {
		if ip := net.ParseIP(h); ip != nil && ip.To4() == nil {
			return "[" + h + "]", true
		}
		return h, true
	}
	return "", false
}
