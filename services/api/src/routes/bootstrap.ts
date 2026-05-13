// /v1/admin/bootstrap: one-time seed of the first admin:rotate key.
// Protected by POLARIS_SECRET_A (control-plane HMAC); idempotent (subsequent calls 409).
import { Hono } from 'hono';
import type { Env } from '../env.js';
import { audit } from '../audit.js';
import { buildError } from '../errors.js';
import { hashSecret } from '../hashing.js';
import { ulid } from '../ids.js';
import { generateSecret, verify } from '@polaris-email/hmac';

export const bootstrap = new Hono<{ Bindings: Env }>();

bootstrap.post('/v1/admin/bootstrap', async (c) => {
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
  // Idempotency: bootstrap (id=1) is seeded by 0001_init; we may need to
  // INSERT it on first call against a fresh test DB.
  const row = await c.env.DB.prepare(
    `SELECT id, consumed_at, admin_key_id FROM bootstrap WHERE id = ?`,
  )
    .bind(1)
    .first<{ id: number; consumed_at: string | null; admin_key_id: string | null }>();
  if (row?.consumed_at) {
    return buildError(c, 'conflict', 'bootstrap already consumed');
  }
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const tenantId = ulid();
  const principalId = ulid();
  const keyId = ulid();
  const secret = generateSecret();
  const hashed = await hashSecret(secret, c.env.ARGON2_PEPPER);

  // 1) Bootstrap tenant for the admin principal.
  await c.env.DB.prepare(
    `INSERT INTO tenants (id, name, description, environment, pepper_version, created_at, updated_at)
     VALUES (?, ?, ?, 'prod', 1, ?, ?)`,
  )
    .bind(tenantId, '__bootstrap__', 'bootstrap admin tenant', nowIso, nowIso)
    .run();
  // 2) Principal for the admin api_key.
  await c.env.DB.prepare(
    `INSERT INTO principals (id, tenant_id, kind, display_name, environment, created_at)
     VALUES (?, ?, 'api_key', 'bootstrap-admin', 'prod', ?)`,
  )
    .bind(principalId, tenantId, nowIso)
    .run();
  // 3) The api_key itself.
  await c.env.DB.prepare(
    `INSERT INTO api_keys
       (id, principal_id, prefix, secret_argon2id, scopes, sender_scopes,
        rate_limit_per_min, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'primary', ?)`,
  )
    .bind(
      keyId,
      principalId,
      'pk_admin_',
      hashed,
      '["admin:rotate","admin:read"]',
      '[]',
      60,
      nowIso,
    )
    .run();
  await c.env.KV_KEY_CACHE.put(`plain:${keyId}`, secret, {
    expirationTtl: 60 * 60 * 24 * 365,
  });
  if (row) {
    await c.env.DB.prepare(
      `UPDATE bootstrap SET consumed_at = ?, admin_key_id = ? WHERE id = ?`,
    )
      .bind(nowIso, keyId, 1)
      .run();
  } else {
    await c.env.DB.prepare(
      `INSERT INTO bootstrap (id, consumed_at, admin_key_id) VALUES (?, ?, ?)`,
    )
      .bind(1, nowIso, keyId)
      .run();
  }
  await audit(c.env, {
    actor: 'bootstrap',
    action: 'bootstrap.consume',
    target: keyId,
    meta: { issued_at: now },
  });
  return c.json({ admin_key_id: keyId, admin_key_secret: secret });
});
