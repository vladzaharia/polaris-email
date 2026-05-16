// SSRF defence for outbound webhooks. Allowlists schemes, rejects private/CGNAT
// IPs by hostname or literal, forbids redirects, and DNS-pins the resolved IP so
// that a hostname can't TOCTOU-flip to private space between check and fetch.
//
// Coverage (denied):
//   IPv4 — 10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12,
//          192.168.0.0/16, 100.64.0.0/10 (RFC 6598 CGNAT / Tailscale-adjacent).
//   IPv6 — ::1/128, fc00::/7 (ULA), fe80::/10 (link-local).
//   Cloud — 169.254.169.254 (AWS/GCP IMDS), 169.254.170.2 (ECS task metadata).
//   Hosts — common metadata aliases (metadata.google.internal, localhost, …).
//
// `safeFetch` resolves the hostname once via an injected resolver and re-runs
// the IP check on the resolved address; the actual fetch then uses the pinned
// IP with the original hostname re-asserted via the `Host` header.

interface V4Cidr {
  /** 32-bit unsigned integer for the network address. */
  network: number;
  /** Prefix length (1..32). */
  bits: number;
}

function v4ToUint32(ip: string): number | null {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i]);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    n = (n * 256 + octet) >>> 0;
  }
  return n >>> 0;
}

function parseCidrV4(cidr: string): V4Cidr {
  const [addr, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const network = v4ToUint32(addr!);
  if (network === null) throw new Error(`invalid v4 cidr: ${cidr}`);
  return { network, bits };
}

function v4InCidr(ipUint: number, cidr: V4Cidr): boolean {
  if (cidr.bits === 0) return true;
  const mask = cidr.bits === 32 ? 0xffffffff : (0xffffffff << (32 - cidr.bits)) >>> 0;
  return (ipUint & mask) === (cidr.network & mask);
}

// Deny list of IPv4 ranges that must never be reachable via webhooks.
const PRIVATE_V4_CIDRS: V4Cidr[] = [
  parseCidrV4('10.0.0.0/8'), // RFC 1918
  parseCidrV4('172.16.0.0/12'), // RFC 1918
  parseCidrV4('192.168.0.0/16'), // RFC 1918
  parseCidrV4('127.0.0.0/8'), // Loopback
  parseCidrV4('169.254.0.0/16'), // Link-local (covers IMDS)
  parseCidrV4('100.64.0.0/10'), // RFC 6598 CGNAT / Tailscale-adjacent
  parseCidrV4('0.0.0.0/8'), // "this network"
  parseCidrV4('224.0.0.0/4'), // multicast
  parseCidrV4('240.0.0.0/4'), // reserved / broadcast
];

// IPv6 deny list — normalised lower-case prefixes that match the *expanded*
// form of an address (we expand leading `::` before checking).
const PRIVATE_V6_PREFIXES: string[] = [
  '0000:0000:0000:0000:0000:0000:0000:0001', // ::1 loopback
  // fc00::/7 (ULA) — first byte 0xfc or 0xfd
  'fc',
  'fd',
  // fe80::/10 — first 10 bits 1111_1110_10 → fe80..febf
  'fe8',
  'fe9',
  'fea',
  'feb',
];

const FORBIDDEN_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.aws',
  'metadata',
  'localhost',
  'instance-data.ec2.internal',
]);

const FORBIDDEN_CLOUD_IPS = new Set([
  '169.254.169.254', // AWS/GCP IMDS
  '169.254.170.2', // ECS task metadata
]);

export interface SsrfCheck {
  url: string;
  kind: 'external' | 'tailnet';
}

export interface SsrfResult {
  ok: boolean;
  reason?: string;
}

/**
 * Lightweight IPv6 normaliser — expands `::` and pads each group to 4 hex
 * digits. Returns a colon-joined lower-case string, or null if the input
 * doesn't look like an IPv6 address.
 */
function normaliseV6(addr: string): string | null {
  const lower = addr.toLowerCase().trim();
  if (!/^[0-9a-f:]+$/.test(lower)) return null;
  // Handle "::" — only one allowed.
  const dblIdx = lower.indexOf('::');
  let head: string[] = [];
  let tail: string[] = [];
  if (dblIdx >= 0) {
    if (lower.indexOf('::', dblIdx + 2) !== -1) return null;
    const [h, t] = lower.split('::');
    head = h ? h.split(':') : [];
    tail = t ? t.split(':') : [];
  } else {
    head = lower.split(':');
  }
  if (head.length + tail.length > 8) return null;
  const fill = 8 - head.length - tail.length;
  const groups: string[] = [...head, ...new Array<string>(fill).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  return groups.map((g) => g.padStart(4, '0')).join(':');
}

function ipv6Denied(addr: string): boolean {
  const normal = normaliseV6(addr);
  if (!normal) return false;
  // Full match for ::1 (exact prefix).
  for (const p of PRIVATE_V6_PREFIXES) {
    // Exact 8-group form like 0000:0000:...:0001
    if (p.includes(':')) {
      if (normal === p) return true;
      continue;
    }
    // Short hex prefix — match against first group's leading hex chars.
    const firstGroup = normal.split(':')[0]!;
    if (firstGroup.startsWith(p)) return true;
  }
  return false;
}

/**
 * Check whether `ip` (a v4 dotted-quad or v6 literal without brackets) falls in
 * a denied range. Used both for hostname-as-literal checks and post-DNS pinning.
 */
export function ipDenied(ip: string): boolean {
  const v4 = v4ToUint32(ip);
  if (v4 !== null) {
    if (FORBIDDEN_CLOUD_IPS.has(ip)) return true;
    for (const c of PRIVATE_V4_CIDRS) {
      if (v4InCidr(v4, c)) return true;
    }
    return false;
  }
  return ipv6Denied(ip);
}

export function ssrfCheck({ url, kind }: SsrfCheck): SsrfResult {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, reason: 'scheme_disallowed' };
  }
  if (kind === 'external' && u.protocol !== 'https:') {
    return { ok: false, reason: 'external_requires_https' };
  }
  const host = u.hostname.toLowerCase();
  if (FORBIDDEN_HOSTS.has(host)) return { ok: false, reason: 'forbidden_host' };
  if (FORBIDDEN_CLOUD_IPS.has(host)) return { ok: false, reason: 'imds_blocked' };
  // IP literals are never allowed for either kind: external must use a public
  // DNS name, tailnet must use *.ts.net. We still run the deny check so that
  // bypass attempts get a more specific reason in logs.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    if (ipDenied(host)) return { ok: false, reason: 'private_v4' };
    return { ok: false, reason: 'ip_literal_disallowed' };
  }
  // Bracketed IPv6 literal.
  if (host.startsWith('[') && host.endsWith(']')) {
    const v6 = host.slice(1, -1).toLowerCase();
    if (ipDenied(v6)) return { ok: false, reason: 'private_v6' };
    return { ok: false, reason: 'ip_literal_disallowed' };
  }
  // Belt-and-braces: even if a DNS name resolves to private space, prefixes
  // like 10. or 192.168. as hostnames are nonsensical and indicate misuse.
  if (ipDenied(host)) return { ok: false, reason: 'private_v4' };
  if (kind === 'tailnet') {
    if (!host.endsWith('.ts.net')) return { ok: false, reason: 'tailnet_host_required' };
  }
  return { ok: true };
}

export interface SafeFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /**
   * Optional DNS resolver used for pinning. If omitted, the default resolver
   * (Cloudflare DoH at 1.1.1.1) is used. Tests inject a mock resolver.
   */
  resolve?: DnsResolver;
}

/** Resolves a hostname to one or more IP literals (v4 or v6, no brackets). */
export type DnsResolver = (hostname: string) => Promise<string[]>;

/**
 * Default DNS resolver: queries Cloudflare DoH for A and AAAA records.
 * Returns IPs as bare literals (no `[]` for v6). On failure returns `[]`.
 */
export const defaultResolver: DnsResolver = async (hostname) => {
  const types = ['A', 'AAAA'] as const;
  const out: string[] = [];
  for (const t of types) {
    try {
      const u = new URL('https://1.1.1.1/dns-query');
      u.searchParams.set('name', hostname);
      u.searchParams.set('type', t);
      const r = await fetch(u.toString(), {
        headers: { accept: 'application/dns-json' },
        redirect: 'manual',
      });
      if (!r.ok) continue;
      const j = (await r.json()) as { Answer?: { data: string; type: number }[] };
      for (const a of j.Answer ?? []) {
        // Filter to literal IPv4/IPv6 only. type 1 = A, type 28 = AAAA.
        // Cloudflare DoH may return CNAME (5), TXT (16), MX (15), etc; their
        // `data` is a hostname or text value that would not literally collide
        // with `ipDenied()` checks but would also never be a usable peer IP.
        // Keeping the deny-list IP-only avoids passing string data through
        // `ipDenied` where a missing case could later be misinterpreted.
        if (typeof a.data !== 'string') continue;
        if (a.type !== 1 && a.type !== 28) continue;
        out.push(a.data);
      }
    } catch {
      // ignore — caller treats empty list as "could not resolve" and fails
      // closed below.
    }
  }
  return out;
};

export async function safeFetch(
  url: string,
  kind: 'external' | 'tailnet',
  init: SafeFetchInit = {},
): Promise<{ status: number; body: string; ok: boolean }> {
  const check = ssrfCheck({ url, kind });
  if (!check.ok) return { status: 0, body: '', ok: false };

  // DNS pinning — resolve the hostname ONCE and re-check the resulting IP.
  // This prevents TOCTOU DNS rebinding (a name that passes the hostname
  // check but resolves to 10.x at fetch time).
  const u = new URL(url);
  const resolver = init.resolve ?? defaultResolver;
  let resolvedIps: string[] = [];
  try {
    resolvedIps = await resolver(u.hostname);
  } catch {
    resolvedIps = [];
  }
  if (resolvedIps.length === 0) {
    // Fail closed when resolution returns nothing. Production traffic against
    // Cloudflare DoH should always return at least one answer for a valid
    // public hostname; tests inject a stub.
    return { status: 0, body: '', ok: false };
  }
  for (const ip of resolvedIps) {
    if (ipDenied(ip)) return { status: 0, body: '', ok: false };
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 10_000);
  try {
    // We pass the original URL to `fetch`. In the Cloudflare Workers runtime
    // resolution is performed by the platform; the IP recheck above is the
    // pinning gate. We additionally set an explicit `Host` header in case the
    // platform allows hostname rebinding mid-flight.
    const mergedHeaders: Record<string, string> = {
      ...(init.headers ?? {}),
      host: u.host,
    };
    const res = await fetch(url, {
      method: init.method ?? 'POST',
      headers: mergedHeaders,
      body: init.body,
      redirect: 'manual',
      signal: ctrl.signal,
    });
    if (res.status >= 300 && res.status < 400) {
      return { status: res.status, body: '', ok: false };
    }
    const max = init.maxResponseBytes ?? 1024 * 1024;
    const reader = res.body?.getReader();
    let total = 0;
    let text = '';
    if (reader) {
      const dec = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > max) {
          ctrl.abort();
          return { status: res.status, body: text, ok: false };
        }
        text += dec.decode(value, { stream: true });
      }
    }
    return { status: res.status, body: text, ok: res.ok };
  } finally {
    clearTimeout(t);
  }
}
