// Hourly: sign the latest audit_log row_hash and write the anchor to R2.
// R2 has Object Lock; this is the off-platform tamper-evidence record.
import type { Env } from '../env.js';

function asBuf(u8: Uint8Array): ArrayBuffer {
  const b = new ArrayBuffer(u8.byteLength);
  new Uint8Array(b).set(u8);
  return b;
}
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function toHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}
async function hmac(secret: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    asBuf(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, asBuf(data)));
}

export async function anchor(env: Env): Promise<void> {
  if (!env.ANCHOR_SIGNING_KEY) {
    // eslint-disable-next-line no-console
    console.warn('anchor: no signing key configured');
    return;
  }
  const secret = b64ToBytes(env.ANCHOR_SIGNING_KEY);
  const head = await env.DB.prepare(
    `SELECT id, row_hash, at FROM audit_log ORDER BY id DESC LIMIT 1`,
  ).first<{ id: number; row_hash: string; at: number }>();
  if (!head) return;
  const signedAt = Date.now();
  const canonical = `polaris-email/anchor\n${head.id}\n${head.row_hash}\n${signedAt}`;
  const sig = await hmac(secret, new TextEncoder().encode(canonical));
  const sigHex = toHex(sig);
  const externalRef = `${env.ANCHOR_R2_PREFIX}${signedAt}-${head.id}.json`;
  const payload = {
    service: 'polaris-email',
    last_audit_id: head.id,
    last_row_hash: head.row_hash,
    signed_at: signedAt,
    sig: sigHex,
  };
  await env.R2.put(externalRef, JSON.stringify(payload), {
    httpMetadata: { contentType: 'application/json' },
  });
  await env.DB.prepare(
    `INSERT INTO audit_anchors (last_audit_id, last_row_hash, signature, signed_at, external_ref)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(head.id, head.row_hash, sigHex, signedAt, externalRef)
    .run();
}
