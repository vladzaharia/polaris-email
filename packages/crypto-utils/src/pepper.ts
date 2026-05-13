// Pepper derivation for per-tenant message hashing (H5/I13).
//
// Master pepper is a base64-encoded high-entropy secret held in operator-managed
// secrets. We derive a per-tenant pepper using HKDF-SHA256 with a fixed salt
// label and the tenant id as `info`. The output is 32 bytes suitable for use
// as the inner key for HMAC/Argon2 inputs that need tenant isolation.
//
// Pepper version is derived from sha256(master) so operators can rotate the
// master and have `messages.pepper_version` reflect the change automatically.

const SALT = new TextEncoder().encode('polaris-email/tenant-pepper/v1');

function fromBase64(s: string): Uint8Array {
  // Works in both Node and Workers (atob is available in both as of recent runtimes).
  const bin = typeof atob === 'function' ? atob(s) : Buffer.from(s, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function asBufferSource(u8: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(u8.byteLength);
  new Uint8Array(buf).set(u8);
  return buf;
}

export async function deriveTenantPepper(
  masterB64: string,
  tenantId: string,
): Promise<Uint8Array> {
  if (!masterB64) throw new Error('crypto-utils: masterB64 empty');
  if (!tenantId) throw new Error('crypto-utils: tenantId empty');
  const ikm = fromBase64(masterB64);
  if (ikm.byteLength < 16) {
    throw new Error('crypto-utils: master pepper must be at least 16 bytes');
  }
  const baseKey = await crypto.subtle.importKey(
    'raw',
    asBufferSource(ikm),
    { name: 'HKDF' },
    false,
    ['deriveBits'],
  );
  const info = new TextEncoder().encode(tenantId);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: asBufferSource(SALT),
      info: asBufferSource(info),
    },
    baseKey,
    256,
  );
  return new Uint8Array(bits);
}

export function pepperVersionFromMaster(masterB64: string): number {
  // Synchronous, stable, no async needed by callers — uses a small in-process
  // FNV-1a folded over sha-256 would be ideal but sha-256 is async in WebCrypto.
  // Instead we apply a stable FNV-1a hash of the raw bytes and take low 16 bits.
  // This is not a cryptographic identifier — it is just a stable change tag.
  if (!masterB64) throw new Error('crypto-utils: masterB64 empty');
  const bytes = fromBase64(masterB64);
  let hash = 0x811c9dc5; // FNV offset basis (32-bit)
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i] ?? 0;
    // 32-bit FNV prime multiplication
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash & 0xffff;
}
