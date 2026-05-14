// HMAC canonical-string signer/verifier for polaris-email.
//
// Domain-separation tags pin the signature to a direction:
//   polaris-api.v1     — inbound API requests (caller → polaris-email)
//   polaris-webhook.v1 — outbound webhooks    (polaris-email → consumer)
//
// Canonical string (newline-joined, no trailing newline):
//   <domain>\n
//   <METHOD>\n
//   <path>\n
//   <canonical-query>\n
//   <X-Polaris-Ts>\n
//   <X-Polaris-Nonce>\n
//   <lowercase-hex(SHA-256(raw-body-bytes))>
//
// Signature header: `X-Polaris-Sig: v1=<lowercase-hex(HMAC-SHA256(secret, canonical))>`
// Verifiers MUST compare the full `v1=` prefix against an allowlist; downgrade is rejected.

export type Direction = 'polaris-api.v1' | 'polaris-webhook.v1';

export interface CanonicalInput {
  direction: Direction;
  method: string; // uppercased internally
  path: string; // leading slash, no fragment
  query?: string | URLSearchParams | Record<string, string | string[]> | undefined;
  ts: string;
  nonce: string;
  body: Uint8Array | string;
}

export interface SignedRequest {
  ts: string;
  nonce: string;
  sig: string; // 'v1=<hex>'
}

export interface VerifyInput {
  direction: Direction;
  method: string;
  path: string;
  query?: string | URLSearchParams | Record<string, string | string[]> | undefined;
  headers: HeadersLike;
  body: Uint8Array | string;
  secret: string | Uint8Array;
  allowedAlgorithms?: readonly string[]; // default ['v1']
  skewSeconds?: number; // default 300 (5 min)
  now?: () => number; // ms epoch, for tests
}

export type HeadersLike = {
  get(name: string): string | null;
};

export type VerifyResultOk = { ok: true; algorithm: string; ts: number; nonce: string };
export type VerifyResultErr = {
  ok: false;
  code: 'missing_header' | 'header_invalid' | 'clock_skew' | 'algorithm_rejected' | 'bad_signature';
  message: string;
};
export type VerifyResult = VerifyResultOk | VerifyResultErr;

// ---------- canonicalization ----------

export function canonicalQuery(
  input: string | URLSearchParams | Record<string, string | string[]> | undefined,
): string {
  if (input == null) return '';
  let params: [string, string][];
  if (typeof input === 'string') {
    if (input === '') return '';
    const sp = new URLSearchParams(input.startsWith('?') ? input.slice(1) : input);
    params = [...sp.entries()];
  } else if (input instanceof URLSearchParams) {
    params = [...input.entries()];
  } else {
    params = [];
    for (const [k, v] of Object.entries(input)) {
      if (Array.isArray(v)) for (const vv of v) params.push([k, vv]);
      else params.push([k, v]);
    }
  }
  // Sort by lowercase key, then value, both percent-encoded per RFC3986.
  params.sort((a, b) => {
    const ka = a[0].toLowerCase();
    const kb = b[0].toLowerCase();
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    if (a[1] < b[1]) return -1;
    if (a[1] > b[1]) return 1;
    return 0;
  });
  return params.map(([k, v]) => `${encode(k.toLowerCase())}=${encode(v)}`).join('&');
}

function encode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', asBufferSource(bytes));
  return toHex(new Uint8Array(digest));
}

export function toBytes(input: Uint8Array | string): Uint8Array {
  if (typeof input === 'string') return new TextEncoder().encode(input);
  return input;
}

export async function buildCanonical(input: CanonicalInput): Promise<string> {
  assertNoCrlf('ts', input.ts);
  assertNoCrlf('nonce', input.nonce);
  const body = toBytes(input.body);
  const bodyHash = await sha256Hex(body);
  const method = input.method.toUpperCase();
  if (!/^[A-Z]+$/.test(method)) throw new Error('hmac: invalid HTTP method');
  if (!input.path.startsWith('/')) throw new Error('hmac: path must start with /');
  const query = canonicalQuery(input.query);
  return [input.direction, method, input.path, query, input.ts, input.nonce, bodyHash].join('\n');
}

// ---------- crypto helpers ----------

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hmac: odd hex length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const b = parseInt(hex.substr(i * 2, 2), 16);
    if (Number.isNaN(b)) throw new Error('hmac: invalid hex');
    out[i] = b;
  }
  return out;
}

/** Constant-time byte comparison. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let acc = 0;
  for (let i = 0; i < a.length; i++) acc |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return acc === 0;
}

/** Copy a Uint8Array into a fresh ArrayBuffer view (defends against TS's `ArrayBufferLike` strictness). */
function asBufferSource(u8: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(u8.byteLength);
  new Uint8Array(buf).set(u8);
  return buf;
}

async function hmacSha256(secret: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    asBufferSource(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, asBufferSource(data));
  return new Uint8Array(sig);
}

function secretBytes(secret: string | Uint8Array): Uint8Array {
  if (typeof secret === 'string') return new TextEncoder().encode(secret);
  return secret;
}

// ---------- sign + verify ----------

export async function sign(input: CanonicalInput, secret: string | Uint8Array): Promise<string> {
  const canonical = await buildCanonical(input);
  const tag = await hmacSha256(secretBytes(secret), new TextEncoder().encode(canonical));
  return 'v1=' + toHex(tag);
}

/** Strict ASCII header value check: refuse whitespace, CR, LF, NUL. */
export function assertNoCrlf(name: string, value: string): void {
  if (typeof value !== 'string') throw new Error(`hmac: ${name} not a string`);
  if (value.length === 0) throw new Error(`hmac: ${name} empty`);
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 0x0a || c === 0x0d || c === 0x00 || c === 0x09 || c === 0x20) {
      throw new Error(`hmac: ${name} contains whitespace or control character`);
    }
    if (c > 0x7e) throw new Error(`hmac: ${name} non-ASCII`);
  }
}

const ALG_RE = /^v\d+=[0-9a-f]+$/;

export async function verify(input: VerifyInput): Promise<VerifyResult> {
  const allowed = new Set(input.allowedAlgorithms ?? ['v1']);
  const skew = (input.skewSeconds ?? 300) * 1000;
  const now = (input.now ?? Date.now)();
  const tsHeader = input.headers.get('x-polaris-ts');
  const nonceHeader = input.headers.get('x-polaris-nonce');
  const sigHeader = input.headers.get('x-polaris-sig');
  if (!tsHeader) return { ok: false, code: 'missing_header', message: 'X-Polaris-Ts missing' };
  if (!nonceHeader)
    return { ok: false, code: 'missing_header', message: 'X-Polaris-Nonce missing' };
  if (!sigHeader) return { ok: false, code: 'missing_header', message: 'X-Polaris-Sig missing' };
  try {
    assertNoCrlf('X-Polaris-Ts', tsHeader);
    assertNoCrlf('X-Polaris-Nonce', nonceHeader);
    assertNoCrlf('X-Polaris-Sig', sigHeader);
  } catch (e) {
    return {
      ok: false,
      code: 'header_invalid',
      message: e instanceof Error ? e.message : 'invalid header',
    };
  }
  if (!ALG_RE.test(sigHeader)) {
    return { ok: false, code: 'header_invalid', message: 'signature format' };
  }
  const eqIdx = sigHeader.indexOf('=');
  const prefix = sigHeader.slice(0, eqIdx);
  const hex = sigHeader.slice(eqIdx + 1);
  if (!allowed.has(prefix)) {
    return { ok: false, code: 'algorithm_rejected', message: prefix };
  }
  const ts = Number.parseInt(tsHeader, 10);
  if (!Number.isFinite(ts) || `${ts}` !== tsHeader) {
    return { ok: false, code: 'header_invalid', message: 'ts not an integer' };
  }
  if (Math.abs(now - ts) > skew) {
    return { ok: false, code: 'clock_skew', message: `|now-ts|>${skew / 1000}s` };
  }
  if (nonceHeader.length < 16 || nonceHeader.length > 128) {
    return { ok: false, code: 'header_invalid', message: 'nonce length' };
  }
  let canonical: string;
  try {
    canonical = await buildCanonical({
      direction: input.direction,
      method: input.method,
      path: input.path,
      query: input.query,
      ts: tsHeader,
      nonce: nonceHeader,
      body: input.body,
    });
  } catch (e) {
    return {
      ok: false,
      code: 'header_invalid',
      message: e instanceof Error ? e.message : 'canonicalization failed',
    };
  }
  const expected = await hmacSha256(secretBytes(input.secret), new TextEncoder().encode(canonical));
  let provided: Uint8Array;
  try {
    provided = fromHex(hex);
  } catch {
    return { ok: false, code: 'header_invalid', message: 'sig hex invalid' };
  }
  if (!constantTimeEqual(expected, provided)) {
    return { ok: false, code: 'bad_signature', message: 'hmac mismatch' };
  }
  return { ok: true, algorithm: prefix, ts, nonce: nonceHeader };
}

/** Convenience: generate a nonce (24 base32 crockford chars from 15 random bytes). */
export function generateNonce(): string {
  const bytes = new Uint8Array(15);
  crypto.getRandomValues(bytes);
  return crockford32(bytes);
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function crockford32(bytes: Uint8Array): string {
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(acc >> bits) & 31];
    }
  }
  if (bits > 0) out += CROCKFORD[(acc << (5 - bits)) & 31];
  return out;
}

/** Convenience: 256-bit secret in Crockford base32. */
export function generateSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return crockford32(bytes);
}
