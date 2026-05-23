// argon2id + per-tenant pepper + recipient-list HMAC.
// argon2id parameters declared here (one place) so an upgrade is one PR.
//
// Cloudflare Workers do not ship a native argon2 binary. We use a pure-WebCrypto PBKDF2-SHA256
// based KDF with the runtime's max-supported iteration count as an interim that still meets the
// requirement of "irreversible + slow" for secret-at-rest hashing. The verifier records the
// algorithm and iteration count in the stored prefix so a future argon2id migration adds a new
// prefix and rehashes lazily.
//
// 100k is the Workers-runtime cap on `crypto.subtle.deriveBits` for PBKDF2 (workerd throws
// NotSupportedError for higher counts). NIST SP 800-132 recommends ≥600k for PBKDF2-SHA256,
// but the runtime constraint binds. Defense in depth: the per-deploy ARGON2_PEPPER secret
// must be compromised in addition to the stored hash for a brute-force to be feasible.
//
// Format: `$pbkdf2-sha256$i=100000$<saltb64>$<hashb64>` (PHC-like).
// Verify with constant-time compare.

export const KDF_ITERATIONS = 100_000;
export const KDF_OUTLEN = 32;
export const KDF_SALTLEN = 16;
export const KDF_ID = 'pbkdf2-sha256';

function b64enc(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, '');
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

function b64dec(s: string): Uint8Array {
  // Restore any padding stripped by b64enc above.
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Constant-time verify of a candidate plaintext against a PHC-formatted
 * PBKDF2-SHA256 hash produced by `hashSecret`. Returns `false` for any
 * malformed input — never throws. The `pepper` MUST match the deploy
 * pepper used at hash time (`ARGON2_PEPPER`), else verification fails.
 *
 * Used by the new mailbox-credential Bearer auth path (services/api/
 * src/auth.ts) where the verifier needs to compare against the stored
 * hash directly rather than against a KV-cached plaintext (the existing
 * X-Polaris-Key-Id HMAC path goes through the KV plaintext cache).
 */
export async function verifyPbkdf2(
  hash: string,
  plain: string,
  pepper: string | undefined,
): Promise<boolean> {
  // Format: `$pbkdf2-sha256$i=<iters>$<saltb64>$<hashb64>`
  const parts = hash.split('$');
  if (parts.length !== 5) return false;
  if (parts[0] !== '') return false;
  if (parts[1] !== KDF_ID) return false;
  const itersStr = parts[2];
  if (!itersStr || !itersStr.startsWith('i=')) return false;
  const iters = Number.parseInt(itersStr.slice(2), 10);
  if (!Number.isFinite(iters) || iters <= 0 || iters > 10_000_000) return false;
  const saltB64 = parts[3];
  const expectedB64 = parts[4];
  if (!saltB64 || !expectedB64) return false;
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = b64dec(saltB64);
    expected = b64dec(expectedB64);
  } catch {
    return false;
  }
  if (expected.length === 0) return false;
  const peppered = new TextEncoder().encode(plain + (pepper ?? ''));
  const computed = await pbkdf2(peppered, salt, iters, expected.length);
  if (computed.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed[i]! ^ expected[i]!;
  return diff === 0;
}
