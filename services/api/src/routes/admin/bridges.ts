// Admin bridges routes. The `bridges` row records each registered
// mail-bridge instance + its HMAC key reference.
//
// Read-once secret discipline (A11 / B6):
//   * POST /v1/admin/bridges returns the plaintext HMAC key ONCE.
//   * POST /v1/admin/bridges/:id/rotate returns the new key ONCE.
//   * GET responses omit the stored hash column entirely.
import { Hono } from 'hono';
import { audit } from '../../audit.js';
import { bodyText, requireScope } from '../../auth.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';
import { ulid } from '@polaris-email/ids';
import { generateSecret } from '@polaris-email/hmac';
import { hashSecret } from '../../hashing.js';

export const bridges = new Hono<{ Bindings: Env }>();

interface BridgeRow {
  id: string;
  name: string;
  hmac_key_secret_name: string | null;
  access_token_id: string | null;
  last_seen_at: string | null;
  created_at: string;
  disabled_at: string | null;
}

bridges.get('/v1/admin/bridges', requireScope('admin:read'), async (c) => {
  // Note: `hmac_key_secret_name` (the stored argon2id hash of the HMAC key)
  // is deliberately omitted from GET responses per A11.
  const rows = await c.env.DB.prepare(
    `SELECT id, name, access_token_id,
            last_seen_at, created_at, disabled_at
     FROM bridges ORDER BY name ASC`,
  ).all<Omit<BridgeRow, 'hmac_key_secret_name'>>();
  return c.json({ data: rows.results });
});

bridges.post('/v1/admin/bridges', requireScope('admin:rotate'), async (c) => {
  const key = c.get('apiKey');
  let body: { name?: string };
  try {
    body = JSON.parse(bodyText(c) || '{}') as { name?: string };
  } catch {
    return buildError(c, 'bad_request', 'invalid json');
  }
  if (!body.name || typeof body.name !== 'string' || body.name.length < 1) {
    return buildError(c, 'bad_request', 'name required');
  }
  const id = ulid();
  const secret = generateSecret();
  const hashed = await hashSecret(secret, c.env.ARGON2_PEPPER);
  const nowIso = new Date().toISOString();
  try {
    await c.env.DB.prepare(
      `INSERT INTO bridges (id, name, hmac_key_secret_name, created_at)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(id, body.name, hashed, nowIso)
      .run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) return buildError(c, 'conflict', 'bridge name taken');
    throw e;
  }
  await audit(c.env, {
    actor: `key:${key.key_id}`,
    action: 'bridge.register',
    target: id,
    meta: { name: body.name },
  });
  return c.json({ id, name: body.name, hmac_key: secret }, 201);
});

bridges.get('/v1/admin/bridges/lookup', requireScope('admin:read'), async (c) => {
  const name = c.req.query('name');
  if (!name) return buildError(c, 'bad_request', 'name required');
  // Hash column omitted from GET responses (A11).
  const row = await c.env.DB.prepare(
    `SELECT id, name, access_token_id,
            last_seen_at, created_at, disabled_at
     FROM bridges WHERE name = ?`,
  )
    .bind(name)
    .first<Omit<BridgeRow, 'hmac_key_secret_name'>>();
  if (!row) return buildError(c, 'not_found', 'bridge not found');
  return c.json(row);
});

bridges.get('/v1/admin/bridges/:id', requireScope('admin:read'), async (c) => {
  const id = c.req.param('id');
  // Hash column omitted from GET responses (A11).
  const row = await c.env.DB.prepare(
    `SELECT id, name, access_token_id,
            last_seen_at, created_at, disabled_at
     FROM bridges WHERE id = ?`,
  )
    .bind(id)
    .first<Omit<BridgeRow, 'hmac_key_secret_name'>>();
  if (!row) return buildError(c, 'not_found', 'bridge not found');
  return c.json(row);
});

bridges.post('/v1/admin/bridges/:id/rotate', requireScope('admin:rotate'), async (c) => {
  const key = c.get('apiKey');
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare(`SELECT id, name FROM bridges WHERE id = ?`)
    .bind(id)
    .first<{ id: string; name: string }>();
  if (!existing) return buildError(c, 'not_found', 'bridge not found');
  const secret = generateSecret();
  const hashed = await hashSecret(secret, c.env.ARGON2_PEPPER);
  await c.env.DB.prepare(`UPDATE bridges SET hmac_key_secret_name = ? WHERE id = ?`)
    .bind(hashed, id)
    .run();
  await audit(c.env, {
    actor: `key:${key.key_id}`,
    action: 'bridge.rotate',
    target: id,
    meta: { name: existing.name },
  });
  return c.json({ id, hmac_key: secret });
});

bridges.delete('/v1/admin/bridges/:id', requireScope('admin:rotate'), async (c) => {
  const key = c.get('apiKey');
  const id = c.req.param('id');
  const nowIso = new Date().toISOString();
  const r = await c.env.DB.prepare(
    `UPDATE bridges SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL`,
  )
    .bind(nowIso, id)
    .run();
  if (r.meta.changes === 0) return buildError(c, 'not_found', 'not found or already disabled');
  await audit(c.env, {
    actor: `key:${key.key_id}`,
    action: 'bridge.deregister',
    target: id,
    meta: {},
  });
  return c.json({ id, disabled_at: Date.now() });
});
