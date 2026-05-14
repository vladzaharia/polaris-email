// @polaris/webhook-verify — Node verifier for polaris-email webhooks (and inbound API).
// Pure Node `crypto`, no dependencies. Constant-time compare, algorithm allowlist, CRLF refusal.
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

export type Direction = 'polaris-api.v1' | 'polaris-webhook.v1';

export interface VerifyInput {
  direction: Direction;
  method: string;
  path: string;
  /** Either a string ("a=1&b=2"), URLSearchParams, or { [k]: v | v[] }. */
  query?: string | URLSearchParams | Record<string, string | string[]>;
  headers: Headers | Record<string, string | string[] | undefined>;
  /** Raw body bytes (Buffer recommended) — the exact bytes received off the wire. */
  body: Buffer | string;
  secret: string | Buffer;
  /** Default `['v1']`. */
  allowedAlgorithms?: string[];
  /** Default 300 seconds. */
  skewSeconds?: number;
  now?: () => number;
}

export type VerifyResult =
  | { ok: true; algorithm: string; ts: number; nonce: string }
  | {
      ok: false;
      code:
        | 'missing_header'
        | 'header_invalid'
        | 'clock_skew'
        | 'algorithm_rejected'
        | 'bad_signature';
      message: string;
    };

function pickHeader(h: VerifyInput['headers'], name: string): string | null {
  if (h instanceof Headers) return h.get(name);
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  if (!key) return null;
  const v = (h as Record<string, string | string[] | undefined>)[key];
  if (v == null) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

function noCrlf(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x0a || c === 0x0d || c === 0x00 || c === 0x09 || c === 0x20 || c > 0x7e)
      return false;
  }
  return s.length > 0;
}

function canonicalQuery(
  q: string | URLSearchParams | Record<string, string | string[]> | undefined,
): string {
  if (q == null) return '';
  let pairs: [string, string][];
  if (typeof q === 'string') {
    if (!q) return '';
    pairs = [...new URLSearchParams(q.startsWith('?') ? q.slice(1) : q).entries()];
  } else if (q instanceof URLSearchParams) {
    pairs = [...q.entries()];
  } else {
    pairs = [];
    for (const [k, v] of Object.entries(q)) {
      if (Array.isArray(v)) for (const vv of v) pairs.push([k, vv]);
      else pairs.push([k, v]);
    }
  }
  pairs.sort((a, b) => {
    const ka = a[0].toLowerCase();
    const kb = b[0].toLowerCase();
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    if (a[1] < b[1]) return -1;
    if (a[1] > b[1]) return 1;
    return 0;
  });
  return pairs
    .map(
      ([k, v]) =>
        encodeURIComponent(k.toLowerCase()).replace(
          /[!'()*]/g,
          (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
        ) +
        '=' +
        encodeURIComponent(v).replace(
          /[!'()*]/g,
          (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
        ),
    )
    .join('&');
}

export function verify(input: VerifyInput): VerifyResult {
  const allowed = new Set(input.allowedAlgorithms ?? ['v1']);
  const skew = (input.skewSeconds ?? 300) * 1000;
  const now = (input.now ?? Date.now)();
  const tsRaw = pickHeader(input.headers, 'x-polaris-ts');
  const nonce = pickHeader(input.headers, 'x-polaris-nonce');
  const sig = pickHeader(input.headers, 'x-polaris-sig');
  if (!tsRaw) return { ok: false, code: 'missing_header', message: 'X-Polaris-Ts' };
  if (!nonce) return { ok: false, code: 'missing_header', message: 'X-Polaris-Nonce' };
  if (!sig) return { ok: false, code: 'missing_header', message: 'X-Polaris-Sig' };
  if (!noCrlf(tsRaw) || !noCrlf(nonce) || !noCrlf(sig)) {
    return { ok: false, code: 'header_invalid', message: 'whitespace/CRLF in header' };
  }
  if (!/^v\d+=[0-9a-f]+$/.test(sig)) {
    return { ok: false, code: 'header_invalid', message: 'sig format' };
  }
  const eq = sig.indexOf('=');
  const prefix = sig.slice(0, eq);
  const hex = sig.slice(eq + 1);
  if (!allowed.has(prefix)) return { ok: false, code: 'algorithm_rejected', message: prefix };
  const ts = Number.parseInt(tsRaw, 10);
  if (!Number.isFinite(ts) || `${ts}` !== tsRaw) {
    return { ok: false, code: 'header_invalid', message: 'ts not integer' };
  }
  if (Math.abs(now - ts) > skew) return { ok: false, code: 'clock_skew', message: 'ts skew' };
  if (nonce.length < 16 || nonce.length > 128) {
    return { ok: false, code: 'header_invalid', message: 'nonce length' };
  }
  if (!/^[A-Z]+$/.test(input.method.toUpperCase())) {
    return { ok: false, code: 'header_invalid', message: 'method' };
  }
  if (!input.path.startsWith('/')) {
    return { ok: false, code: 'header_invalid', message: 'path' };
  }
  const bodyBuf = typeof input.body === 'string' ? Buffer.from(input.body, 'utf8') : input.body;
  const bodyHash = createHash('sha256').update(bodyBuf).digest('hex');
  const canonical = [
    input.direction,
    input.method.toUpperCase(),
    input.path,
    canonicalQuery(input.query),
    tsRaw,
    nonce,
    bodyHash,
  ].join('\n');
  const secretBuf =
    typeof input.secret === 'string' ? Buffer.from(input.secret, 'utf8') : input.secret;
  const expected = createHmac('sha256', secretBuf).update(canonical).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(hex, 'hex');
  } catch {
    return { ok: false, code: 'header_invalid', message: 'sig hex' };
  }
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { ok: false, code: 'bad_signature', message: 'hmac mismatch' };
  }
  return { ok: true, algorithm: prefix, ts, nonce };
}
