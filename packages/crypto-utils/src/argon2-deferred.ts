// Deferred recipient-hash envelope.
//
// At submit time the API Worker does not have a budget to compute Argon2id
// over the recipient list — Argon2 is intentionally expensive and Workers have
// CPU caps. Instead we encrypt the recipient list with an AES-GCM key derived
// from a global "deferred-hash" KEK and persist the ciphertext on the message.
// The Out Worker (in Phase 4) decrypts, runs Argon2id, and writes
// `recipient_argon2_hash` back.
//
// Wire format:
//   [12-byte IV | 16-byte tag | ciphertext...]
// AES-GCM in WebCrypto produces tag-suffixed ciphertext, so we lay it out as
// IV || (ciphertext || tag). On decrypt we split off the IV and pass the rest
// to subtle.decrypt verbatim.

const IV_LEN = 12;
const TAG_LEN = 16;

function fromBase64(s: string): Uint8Array {
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

async function importAesKey(kekB64: string): Promise<CryptoKey> {
  const raw = fromBase64(kekB64);
  if (raw.byteLength !== 32) {
    throw new Error('crypto-utils: deferred-hash KEK must be 32 bytes (AES-256)');
  }
  return crypto.subtle.importKey(
    'raw',
    asBufferSource(raw),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
}

// Default per-process KEK injection point. In real callers you'll pass the KEK
// explicitly; this helper allows tests / round-trips without singletons.
export async function recipientHashCiphertext(
  recipients: string[],
  kekB64?: string,
): Promise<Uint8Array> {
  if (!Array.isArray(recipients)) throw new Error('crypto-utils: recipients must be array');
  const kek = kekB64 ?? globalThis_DEFERRED_KEK();
  const key = await importAesKey(kek);
  const iv = new Uint8Array(IV_LEN);
  crypto.getRandomValues(iv);
  const plaintext = new TextEncoder().encode(JSON.stringify(recipients));
  const ctWithTag = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: asBufferSource(iv), tagLength: TAG_LEN * 8 },
      key,
      asBufferSource(plaintext),
    ),
  );
  // AES-GCM in WebCrypto returns ciphertext || tag.
  // We re-pack to: IV || tag || ciphertext for an easy header strip.
  const ctLen = ctWithTag.byteLength - TAG_LEN;
  if (ctLen < 0) throw new Error('crypto-utils: encrypt produced too-small output');
  const ct = ctWithTag.subarray(0, ctLen);
  const tag = ctWithTag.subarray(ctLen);
  const out = new Uint8Array(IV_LEN + TAG_LEN + ctLen);
  out.set(iv, 0);
  out.set(tag, IV_LEN);
  out.set(ct, IV_LEN + TAG_LEN);
  return out;
}

export async function decryptRecipients(
  envelope: Uint8Array,
  kekB64: string,
): Promise<string[]> {
  if (envelope.byteLength < IV_LEN + TAG_LEN) {
    throw new Error('crypto-utils: envelope too short');
  }
  const iv = envelope.subarray(0, IV_LEN);
  const tag = envelope.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = envelope.subarray(IV_LEN + TAG_LEN);
  // Re-pack to ciphertext || tag for WebCrypto decrypt.
  const ctWithTag = new Uint8Array(ct.byteLength + TAG_LEN);
  ctWithTag.set(ct, 0);
  ctWithTag.set(tag, ct.byteLength);
  const key = await importAesKey(kekB64);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: asBufferSource(iv), tagLength: TAG_LEN * 8 },
      key,
      asBufferSource(ctWithTag),
    ),
  );
  const text = new TextDecoder().decode(plain);
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed) || !parsed.every((r) => typeof r === 'string')) {
    throw new Error('crypto-utils: decrypted recipients not a string[]');
  }
  return parsed as string[];
}

// In production a process-wide KEK is provided by the runtime env (e.g.
// `env.DEFERRED_HASH_KEK`). We expose a getter so callers may set it via a
// known global without dragging in a Worker `env` object.
function globalThis_DEFERRED_KEK(): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (typeof g.__POLARIS_DEFERRED_HASH_KEK === 'string') {
    return g.__POLARIS_DEFERRED_HASH_KEK;
  }
  throw new Error(
    'crypto-utils: no KEK provided — pass kekB64 or set globalThis.__POLARIS_DEFERRED_HASH_KEK',
  );
}
