// SSRF defence for outbound webhooks. Allowlists schemes, rejects private IPs by hostname or
// literal, and explicitly forbids redirects.
const PRIVATE_V4_CIDRS = [
  // RFC 1918
  { prefix: '10.', bits: 8 },
  { prefix: '192.168.', bits: 16 },
  // Loopback
  { prefix: '127.', bits: 8 },
  // Link-local
  { prefix: '169.254.', bits: 16 },
];

const PRIVATE_V6_PREFIXES = ['fc', 'fd', 'fe80', '::1', '0::1'];

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
  // IP literals are never allowed for either kind: external must use a public DNS name,
  // tailnet must use *.ts.net.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return { ok: false, reason: 'ip_literal_disallowed' };
  }
  if (host.startsWith('[') && host.endsWith(']')) {
    const v6 = host.slice(1, -1).toLowerCase();
    for (const p of PRIVATE_V6_PREFIXES) {
      if (v6.startsWith(p)) return { ok: false, reason: 'private_v6' };
    }
    return { ok: false, reason: 'ip_literal_disallowed' };
  }
  // Belt-and-braces: even if a DNS name resolves to private space, prefixes like 10. or
  // 192.168. as hostnames are nonsensical and indicate misuse.
  for (const c of PRIVATE_V4_CIDRS) {
    if (host.startsWith(c.prefix)) return { ok: false, reason: 'private_v4' };
  }
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
}

export async function safeFetch(
  url: string,
  kind: 'external' | 'tailnet',
  init: SafeFetchInit = {},
): Promise<{ status: number; body: string; ok: boolean }> {
  const check = ssrfCheck({ url, kind });
  if (!check.ok) return { status: 0, body: '', ok: false };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 10_000);
  try {
    const res = await fetch(url, {
      method: init.method ?? 'POST',
      headers: init.headers,
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
