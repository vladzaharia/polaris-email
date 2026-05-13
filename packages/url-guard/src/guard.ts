// Webhook URL SSRF guard (H3 mitigation).
//
// Operators or compromised tenants can configure webhook URLs that point at
// internal infrastructure (RFC1918, link-local, IMDS, Tailnet CGNAT). At
// route create + delivery time, resolve the URL's host, classify the IPs,
// and reject any private/link-local/CGNAT/IMDS/loopback target.
//
// DNS rebinding mitigation: returns the resolved IPs alongside the URL so
// callers can connect to the IP directly (passing Host header) — defense
// against the resolver returning a public IP at validation time and a
// private IP at connect time.

export interface AssertSafeOpts {
  /** Allow loopback URLs (default false). */
  allowLocalhost?: boolean;
  /** Override the DNS resolver (test injection). Default: DoH against 1.1.1.1. */
  resolve?: Resolver;
}

export type Resolver = (hostname: string) => Promise<string[]>;

export interface AssertSafeResult {
  url: URL;
  resolvedIPs: string[];
}

export class UrlGuardError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'parse_failed'
      | 'scheme_rejected'
      | 'port_rejected'
      | 'hostname_rejected'
      | 'ip_rejected'
      | 'dns_empty'
  ) {
    super(message);
  }
}

const ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);
const FORBIDDEN_HOSTNAME_SUFFIXES = ['.local', '.internal'];

export async function assertSafeWebhookUrl(
  raw: string,
  opts: AssertSafeOpts = {}
): Promise<AssertSafeResult> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlGuardError(`unparseable URL: ${raw}`, 'parse_failed');
  }

  // Scheme.
  if (url.protocol === 'http:') {
    const isLocalhost = isLocalhostName(url.hostname);
    if (!opts.allowLocalhost || !isLocalhost) {
      throw new UrlGuardError(`http scheme not allowed: ${raw}`, 'scheme_rejected');
    }
  } else if (url.protocol !== 'https:') {
    throw new UrlGuardError(`unsupported scheme: ${url.protocol}`, 'scheme_rejected');
  }

  // Port.
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!ALLOWED_PORTS.has(port)) {
    throw new UrlGuardError(`port ${port} not in allow-list`, 'port_rejected');
  }

  // Hostname suffix policy.
  const lcHost = url.hostname.toLowerCase();
  for (const suf of FORBIDDEN_HOSTNAME_SUFFIXES) {
    if (lcHost.endsWith(suf)) {
      throw new UrlGuardError(`hostname suffix ${suf} forbidden`, 'hostname_rejected');
    }
  }

  // Resolve to IPs (or accept literal IP host).
  let ips: string[];
  if (isIPLiteral(lcHost)) {
    ips = [lcHost];
  } else {
    const resolver = opts.resolve ?? defaultDohResolver;
    ips = await resolver(url.hostname);
  }
  if (ips.length === 0) {
    throw new UrlGuardError(`DNS returned no records for ${url.hostname}`, 'dns_empty');
  }

  // Reject if ANY resolved IP is forbidden (mixed sets are unsafe — a
  // resolver could rebind the response on a future query). The exception is
  // explicit allowLocalhost, which permits 127.x.x.x / ::1 only.
  for (const ip of ips) {
    if (isForbiddenIP(ip)) {
      const isLoopback = isLoopbackIP(ip);
      if (opts.allowLocalhost && isLoopback) continue;
      throw new UrlGuardError(`resolved IP ${ip} is in a forbidden range`, 'ip_rejected');
    }
  }

  return { url, resolvedIPs: ips };
}

/** Default resolver uses DoH against 1.1.1.1 (Cloudflare). */
async function defaultDohResolver(hostname: string): Promise<string[]> {
  const out: string[] = [];
  for (const t of ['A', 'AAAA']) {
    try {
      const u = `https://1.1.1.1/dns-query?name=${encodeURIComponent(hostname)}&type=${t}`;
      const r = await fetch(u, { headers: { accept: 'application/dns-json' } });
      const j = (await r.json()) as { Answer?: { type: number; data: string }[] };
      for (const a of j.Answer ?? []) {
        if (a.type === 1 || a.type === 28) out.push(a.data);
      }
    } catch {
      // ignore; let the empty-set check fail upstream
    }
  }
  return out;
}

function isLocalhostName(host: string): boolean {
  const lc = host.toLowerCase();
  return lc === 'localhost' || lc === 'localhost.localdomain';
}

function isIPLiteral(host: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(host) || /^[0-9a-f:]+$/i.test(host);
}

function isLoopbackIP(ip: string): boolean {
  if (/^127\./.test(ip)) return true;
  if (ip === '::1') return true;
  if (/^::ffff:127\./i.test(ip)) return true;
  return false;
}

/** Classifies a string as a forbidden IP. Defaults to forbidden for unknown formats. */
export function isForbiddenIP(ip: string): boolean {
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — strip prefix and recurse.
  const v4mapped = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (v4mapped) return isForbiddenIP(v4mapped[1]!);

  // IPv4
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = v4.slice(1).map(Number) as [number, number, number, number];
    if (o.some((n) => n > 255)) return true; // malformed
    // 10.0.0.0/8
    if (o[0] === 10) return true;
    // 172.16.0.0/12
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
    // 192.168.0.0/16
    if (o[0] === 192 && o[1] === 168) return true;
    // 100.64.0.0/10 (CGNAT)
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true;
    // 169.254.0.0/16 (link-local + IMDS)
    if (o[0] === 169 && o[1] === 254) return true;
    // 127.0.0.0/8 (loopback)
    if (o[0] === 127) return true;
    // 0.0.0.0/8
    if (o[0] === 0) return true;
    // 224.0.0.0/4 (multicast) + 240.0.0.0/4 (reserved)
    if (o[0] >= 224) return true;
    return false;
  }

  // IPv6 — handle the ranges we care about. Anything we can't classify, reject.
  if (ip.includes(':')) {
    const lc = ip.toLowerCase();
    if (lc === '::1') return true;
    if (lc === '::') return true;
    // fc00::/7 unique-local (fc00..fdff)
    if (/^f[cd][0-9a-f]{2}:/.test(lc)) return true;
    // fe80::/10 link-local
    if (/^fe[89ab][0-9a-f]:/.test(lc)) return true;
    // ff00::/8 multicast
    if (/^ff[0-9a-f]{2}:/.test(lc)) return true;
    return false;
  }

  // Unrecognized format — fail closed.
  return true;
}
