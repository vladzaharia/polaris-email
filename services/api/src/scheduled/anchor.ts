// Hourly: sign the latest audit_log row_hash and write the anchor to an
// external Object-Lock target (Backblaze B2 by default — see
// `infra/terraform/README.md` for setup). The off-platform write is the
// integrity fence for the single-account Cloudflare topology: a fully
// compromised CF account cannot rewrite history because the B2 credentials
// live outside CF and the bucket enforces Object Lock COMPLIANCE.
//
// Phase O1 replaced the prior `env.R2_ANCHORS.put(...)` (the O0 stop-gap)
// with `putObjectWithLock` against an S3-compatible endpoint.
import { putObjectWithLock } from '@polaris-email/object-lock';
import { toHex } from '@polaris-email/hmac';
import type { Env } from '../env.js';

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Local HMAC-SHA256 helper. The `@polaris-email/hmac` package keeps its
// HMAC primitive private to enforce its canonical-string contract; the
// anchor canonical is `polaris-email/anchor\n<id>\n<row_hash>\n<ts>`,
// which is incompatible with that contract, so we sign locally.
async function hmac(secret: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const secretBuf = new ArrayBuffer(secret.byteLength);
  new Uint8Array(secretBuf).set(secret);
  const dataBuf = new ArrayBuffer(data.byteLength);
  new Uint8Array(dataBuf).set(data);
  const key = await crypto.subtle.importKey(
    'raw',
    secretBuf,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, dataBuf));
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
  const externalRef = `${env.ANCHOR_R2_PREFIX ?? 'anchors/'}${signedAt}-${head.id}.json`;
  const payload = {
    service: 'polaris-email',
    last_audit_id: head.id,
    last_row_hash: head.row_hash,
    signed_at: signedAt,
    sig: sigHex,
  };
  // 4a.6: durability ordering — write D1 BEFORE B2.
  //
  // The previous order (B2 first, then D1) had a tear-window: a B2 success
  // followed by a D1 failure produced an anchor that was visible
  // off-platform but invisible to `verifyChain`, breaking the integrity
  // guarantee for the next verifier run.
  //
  // The reverse order is safe because the B2 object key includes
  // `signedAt` (millisecond precision), so a retry after a B2 failure
  // produces a new key on the second attempt — no idempotency conflict,
  // and at most we leave behind a D1 row whose `external_ref` points at
  // a missing B2 object (operators see this as a "stale anchor" alert
  // and re-anchor manually). That failure mode is dramatically less bad
  // than an anchor that exists in B2 but invisible to D1.
  await env.DB.prepare(
    `INSERT INTO audit_anchors (last_audit_id, last_row_hash, signature, signed_at, external_ref)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(head.id, head.row_hash, sigHex, signedAt, externalRef)
    .run();
  // Now publish to the external Object-Lock target (B2 by default). The
  // `externalRef` is the S3 object key; `audit_anchors.external_ref`
  // stores just the key — the bucket/endpoint live in env.
  await putObjectWithLock(env, externalRef, JSON.stringify(payload));
}
