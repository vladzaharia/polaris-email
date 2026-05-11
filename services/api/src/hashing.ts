// argon2id + per-tenant pepper + recipient-list HMAC.
// argon2id parameters declared here (one place) so an upgrade is one PR.
//
// Cloudflare Workers do not ship a native argon2 binary. We use a pure-WebCrypto PBKDF2-SHA256
// based KDF with a high iteration count as an interim that still meets the requirement of
// "irreversible + slow" for secret-at-rest hashing. The verifier records the algorithm in the
// stored prefix so a future argon2id migration adds a new prefix and rehashes lazily.
//
// Format: `$pbkdf2-sha256$i=600000$<saltb64>$<hashb64>` (PHC-like).
// Verify with constant-time compare.

import { constantTimeEqual } from '@polaris-email/hmac';

export const KDF_ITERATIONS = 600_000;
export const KDF_OUTLEN = 32;
export const KDF_SALTLEN = 16;
export const KDF_ID = 'pbkdf2-sha256';

function b64enc(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, '');
}
function b64dec(s: string): Uint8Array {
  const pad = s + '==='.slice((s.length + 3) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function asBuf(u8: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(u8.byteLength);
  new Uint8Array(buf).set(u8);
  return buf;
}

async function pbkdf2(password: Uint8Array, salt: Uint8Array, iterations: number, outlen: number) {
  const key = await crypto.subtle.importKey('raw', asBuf(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: asBuf(salt), iterations },
    key,
    outlen * 8,
  );
  return new Uint8Array(bits);
}

export async function hashSecret(plain: string, pepper: string | undefined): Promise<string> {
  const salt = new Uint8Array(KDF_SALTLEN);
  crypto.getRandomValues(salt);
  const peppered = new TextEncoder().encode(plain + (pepper ?? ''));
  const out = await pbkdf2(peppered, salt, KDF_ITERATIONS, KDF_OUTLEN);
  return `$${KDF_ID}$i=${KDF_ITERATIONS}$${b64enc(salt)}$${b64enc(out)}`;
}

export async function verifySecret(
  plain: string,
  stored: string,
  pepper: string | undefined,
): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 5 || parts[1] !== KDF_ID || !parts[2]?.startsWith('i='))
    return false;
  const iterations = Number.parseInt(parts[2].slice(2), 10);
  if (!Number.isFinite(iterations) || iterations < 100_000) return false;
  const salt = b64dec(parts[3] ?? '');
  const expected = b64dec(parts[4] ?? '');
  const peppered = new TextEncoder().encode(plain + (pepper ?? ''));
  const got = await pbkdf2(peppered, salt, iterations, expected.length);
  return constantTimeEqual(expected, got);
}

/** HMAC-SHA256 of a recipient list with a per-tenant pepper. Hex-encoded. */
export async function hmacRecipients(addrs: string[], pepper: string): Promise<string> {
  const normalised = addrs.map((a) => a.trim().toLowerCase()).sort();
  const key = await crypto.subtle.importKey(
    'raw',
    asBuf(new TextEncoder().encode(pepper)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    asBuf(new TextEncoder().encode(JSON.stringify(normalised))),
  );
  const bytes = new Uint8Array(sig);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export async function sha256Hex(s: string | Uint8Array): Promise<string> {
  const data =
    typeof s === 'string' ? new TextEncoder().encode(s) : s;
  const digest = await crypto.subtle.digest('SHA-256', asBuf(data));
  const bytes = new Uint8Array(digest);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
