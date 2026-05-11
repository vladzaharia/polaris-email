// /admin/bootstrap: one-time seed of the first admin:rotate key.
// Protected by POLARIS_SECRET_A (control-plane HMAC); idempotent (subsequent calls 409).
import { Hono } from 'hono';
import type { Env } from '../env.js';
import { audit } from '../audit.js';
import { buildError } from '../errors.js';
import { hashSecret } from '../hashing.js';
import { ulid } from '../ids.js';
import { generateSecret, verify } from '@polaris-email/hmac';

export const bootstrap = new Hono<{ Bindings: Env }>();

bootstrap.post('/admin/bootstrap', async (c) => {
  if (!c.env.POLARIS_SECRET_A) {
    return buildError(c, 'forbidden', 'POLARIS_SECRET_A not configured');
  }
  const bodyText = await c.req.text();
  const path = new URL(c.req.url).pathname;
  const query = new URL(c.req.url).search;
  // Bootstrap auth uses the polaris-api.v1 direction, signed with POLARIS_SECRET_A.
  const r = await verify({
    direction: 'polaris-api.v1',
    method: 'POST',
    path,
    query,
    headers: { get: (n: string) => c.req.header(n) ?? null },
    body: bodyText,
    secret: c.env.POLARIS_SECRET_A,
    allowedAlgorithms: c.env.VERIFY_ALGORITHMS.split(','),
  });
  if (!r.ok) return buildError(c, 'bad_signature', `bootstrap auth: ${r.code}`);
  // Idempotency
  const row = await c.env.DB.prepare(
    `SELECT id, consumed_at, pending_key_id FROM bootstrap WHERE id = ?`,
  )
    .bind(1)
    .first<{ id: number; consumed_at: number | null; pending_key_id: string | null }>();
  if (row?.consumed_at) {
    return buildError(c, 'conflict', 'bootstrap already consumed');
  }
  const now = Date.now();
  const keyId = ulid();
  const secret = generateSecret();
  const hashed = await hashSecret(secret, c.env.ARGON2_PEPPER);
  await c.env.DB.prepare(
    `INSERT INTO api_keys
       (id, prefix, secret_argon2id, service_id, sender_scopes, scopes,
        rate_limit_per_min, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      keyId,
      'pk_admin_',
      hashed,
      null,
      '[]',
      '["admin:rotate","admin:read"]',
      60,
      'primary',
      now,
    )
    .run();
  await c.env.KV_KEY_CACHE.put(`plain:${keyId}`, secret, {
    expirationTtl: 60 * 60 * 24 * 365,
  });
  await c.env.DB.prepare(
    `INSERT OR REPLACE INTO bootstrap (id, seeded_at, consumed_at, pending_key_id) VALUES (?, ?, ?, ?)`,
  )
    .bind(1, row?.consumed_at ?? now, now, keyId)
    .run();
  await audit(c.env, {
    actor: 'bootstrap',
    action: 'bootstrap.consume',
    target: keyId,
    meta: { issued_at: now },
  });
  return c.json({ admin_key_id: keyId, admin_key_secret: secret });
});
