// Signed URL minter for attachment downloads.
//
// `mintAttachmentUrl` and `verifyAttachmentUrl` produce/verify URLs of the form
//
//   {API_BASE_URL}/v1/messages/{messageId}/attachments/{n}?sig={hex}&exp={unixSec}
//
// HMAC is keyed by env.POLARIS_SECRET_A (an existing per-deploy secret). The
// signature covers (path + '?exp=' + exp), so the URL is tamper-evident and
// scoped to a single attachment slot. Expiry is enforced by the verifier.

export interface SignedUrlEnv {
  API_BASE_URL: string;
  POLARIS_SECRET_A?: string;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return bytesToHex(new Uint8Array(sig));
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function signingBase(path: string, exp: number): string {
  return `${path}?exp=${exp}`;
}

export async function mintAttachmentUrl(
  env: SignedUrlEnv,
  messageId: string,
  attachmentIndex: number,
  ttlSeconds = 900,
): Promise<string> {
  if (!env.POLARIS_SECRET_A) {
    throw new Error('POLARIS_SECRET_A required to mint attachment URLs');
  }
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const path = `/v1/messages/${messageId}/attachments/${attachmentIndex}`;
  const sig = await hmacHex(env.POLARIS_SECRET_A, signingBase(path, exp));
  const base = env.API_BASE_URL.replace(/\/+$/, '');
  return `${base}${path}?sig=${sig}&exp=${exp}`;
}

export interface VerifiedAttachmentRef {
  messageId: string;
  attachmentIndex: number;
}

/**
 * Verify a signed attachment URL. Returns the parsed ref on success, otherwise
 * a reason string the caller can surface as the 401 message.
 */
export async function verifyAttachmentUrl(
  env: SignedUrlEnv,
  url: string,
): Promise<{ ok: true; ref: VerifiedAttachmentRef } | { ok: false; reason: string }> {
  if (!env.POLARIS_SECRET_A) {
    return { ok: false, reason: 'signing secret not configured' };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'invalid url' };
  }
  const m = parsed.pathname.match(/^\/v1\/messages\/([^/]+)\/attachments\/(\d+)$/);
  if (!m) return { ok: false, reason: 'path shape' };
  const sig = parsed.searchParams.get('sig');
  const expStr = parsed.searchParams.get('exp');
  if (!sig || !expStr) return { ok: false, reason: 'missing sig/exp' };
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= 0) return { ok: false, reason: 'bad exp' };
  if (Math.floor(Date.now() / 1000) > exp) return { ok: false, reason: 'expired' };
  const expected = await hmacHex(env.POLARIS_SECRET_A, signingBase(parsed.pathname, exp));
  if (!timingSafeEqualHex(expected, sig)) return { ok: false, reason: 'sig mismatch' };
  return {
    ok: true,
    ref: { messageId: m[1]!, attachmentIndex: Number(m[2]!) },
  };
}
