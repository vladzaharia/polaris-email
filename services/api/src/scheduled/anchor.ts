// Hourly: sign the latest audit_log row_hash and write the anchor to an
// external Object-Lock target (Backblaze B2 by default — see
// `infra/terraform/README.md` for setup). The off-platform write is the
// integrity fence for the single-account Cloudflare topology: a fully
// compromised CF account cannot rewrite history because the B2 credentials
// live outside CF and the bucket enforces Object Lock COMPLIANCE.
//
// **Custody:** ANCHOR_SIGNING_KEY is a wrangler secret seeded once at deploy
// from the operator vault. It is *not* stored in KV or D1; a fully-
// compromised CF account cannot read it from anywhere CF controls. The B2
// credentials follow the same custody model.
import { putObjectWithLock } from '@polaris-email/object-lock';
import { toHex } from '@polaris-email/hmac';
import type { Env } from '../env.js';
import { recordCronRun } from './cron-runs.js';

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
  const start = Date.now();
  if (!env.ANCHOR_SIGNING_KEY) {
    // eslint-disable-next-line no-console
    console.warn('anchor: no signing key configured');
    await recordCronRun(env, 'anchor', 'skipped', 0, 'no signing key');
    return;
  }
  const secret = b64ToBytes(env.ANCHOR_SIGNING_KEY);
  const head = await env.DB.prepare(
    `SELECT id, row_hash, at FROM audit_log ORDER BY id DESC LIMIT 1`,
  ).first<{ id: number; row_hash: string; at: number }>();
  if (!head) {
    await recordCronRun(env, 'anchor', 'skipped', Date.now() - start, 'empty audit_log');
    return;
  }
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
  // Durability ordering: write D1 BEFORE B2. The reverse order had a
  // tear-window where a B2 success followed by a D1 failure produced an
  // anchor visible off-platform but invisible to verifyChain.
  //
  // The D1 row lands with external_ref_at=NULL so the daily backfill cron
  // can re-publish anchors whose B2 PUT failed. The B2 object key includes
  // signedAt (ms precision), so retries get fresh keys.
  const insertResult = await env.DB.prepare(
    `INSERT INTO audit_anchors (last_audit_id, last_row_hash, signature, signed_at, external_ref)
     VALUES (?, ?, ?, ?, ?)
     RETURNING id`,
  )
    .bind(head.id, head.row_hash, sigHex, signedAt, externalRef)
    .first<{ id: number }>();

  try {
    await putObjectWithLock(env, externalRef, JSON.stringify(payload));
    // Mark the D1 row as off-platform-confirmed.
    if (insertResult?.id != null) {
      const nowIso = new Date().toISOString();
      await env.DB.prepare(`UPDATE audit_anchors SET external_ref_at = ? WHERE id = ?`)
        .bind(nowIso, insertResult.id)
        .run();
    }
    await recordCronRun(env, 'anchor', 'ok', Date.now() - start);
  } catch (e) {
    // B2 PUT failed — D1 row remains with external_ref_at=NULL. The daily
    // anchor-backfill cron will re-publish. Surface the failure for ops.
    const msg = e instanceof Error ? e.message : 'unknown';
    // eslint-disable-next-line no-console
    console.error(
      'anchor: B2 write failed',
      JSON.stringify({
        event: 'anchor_b2_write_failed',
        external_ref: externalRef,
        audit_id: head.id,
        message: msg,
      }),
    );
    await recordCronRun(env, 'anchor', 'error', Date.now() - start, `b2: ${msg}`);
    // Do not rethrow — the D1 row is valid; backfill will retry the B2 leg.
  }
}
