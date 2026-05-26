// Bridge IP detection for the CF A record + the bridge's own service
// advertisement.
//
// Per the polaris-mail convention, services on the same docker network
// resolve `<bridgename>.mail.plrs.im` via Cloudflare DNS — including
// private (RFC1918 / docker-network) IPs. The bridge writes its own
// A record from the renewer loop using the per-bridge CF DNS token.
//
// Source order:
//   1. `BRIDGE_PUBLIC_IP` env override — operators on multi-interface
//      hosts use this to pin a specific address.
//   2. First non-loopback, non-link-local IPv4 across all interfaces.
//      Empirically this is the docker bridge IP on container hosts,
//      and the primary LAN IP on bare-metal — both acceptable.
//
// Returns ("", nil) when no candidate is found and no env override is
// set. The renewer logs and continues — ACME still works (DNS-01
// doesn't need the bridge to be reachable), and an empty A record
// means other services can't resolve the bridge by FQDN, which
// surfaces fast as a "where is the bridge" complaint.
package acme

import (
	"net"
	"os"
)

// DetectBridgeIP returns the bridge's externally-resolvable IPv4 or
// the empty string if none could be determined.
func DetectBridgeIP() string {
	if v := os.Getenv("BRIDGE_PUBLIC_IP"); v != "" {
		return v
	}
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 {
			continue
		}
		if iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ip, _, err := net.ParseCIDR(a.String())
			if err != nil {
				continue
			}
			v4 := ip.To4()
			if v4 == nil {
				continue
			}
			// Skip link-local 169.254.0.0/16 — they're auto-config
			// fallbacks, not real addresses.
			if v4[0] == 169 && v4[1] == 254 {
				continue
			}
			return v4.String()
		}
	}
	return ""
}
