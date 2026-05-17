// Admin operators routes — CRUD for the `operators` table that maps SSH
// pubkey fingerprints + display identity to api_keys, and powers the unified
// CLI/TUI/Wish auth model.
//
// Routes:
//   POST   /v1/admin/operators                  — create operator + api_key (one batch)
//   GET    /v1/admin/operators                  — list (active + disabled)
//   GET    /v1/admin/operators/lookup           — fingerprint → operator (Wish hot path)
//   GET    /v1/admin/operators/:id              — single operator
//   PATCH  /v1/admin/operators/:id              — name/role/disabled
//   DELETE /v1/admin/operators/:id              — soft-disable (alias for PATCH disabled_at)
//   POST   /v1/admin/operators/:id/rotate-key   — rotates underlying api_key
//   POST   /v1/admin/operators/:id/rotate-pubkey — replaces ssh_pubkey + fingerprint
//
// Read-once secret discipline: POST + rotate-key return the api_key_secret
// exactly once (mirrors bridges.register / api-keys.issue).
import { Hono } from 'hono';
import { generateSecret } from '@polaris-email/hmac';
import { ulid } from '@polaris-email/ids';
import { revoke } from '@polaris-email/revocation';
import { KeyScope } from '@polaris-email/schema';
import { z } from 'zod';
import { actorOf, buildAuditInsert } from '../../audit.js';
import { bodyText, requireScope } from '../../auth.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';
import { hashSecret } from '../../hashing.js';

export const operators = new Hono<{ Bindings: Env }>();

// Sentinel mailbox that all operator principals anchor to (created by
// migration 0024). Not user-visible; operator scopes should never include
// `messages:read` or `send` that would let them act against this mailbox.
const OPERATOR_SENTINEL_MAILBOX_ID = '01J0000000000000000000PLRS';

const SSH_FP_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}$/;

const RoleEnum = z.enum(['admin', 'operator', 'readonly']);

const CreateOperatorRequest = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().max(254),
  ssh_pubkey: z
    .string()
    .min(1)
    .max(8192)
    .refine(
      (s) =>
        /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521) /.test(
          s.trim(),
        ),
      {
        message:
          'ssh_pubkey must be a single authorized_keys line (ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp*)',
      },
    ),
  ssh_pubkey_fp_sha256: z
    .string()
    .regex(SSH_FP_PATTERN, 'must be "SHA256:<43-char-base64-no-padding>"'),
  role: RoleEnum.default('operator'),
  scopes: z.array(KeyScope).min(1).default(['admin:read']),
  rate_limit_per_min: z.number().int().positive().max(100000).default(600),
});

const UpdateOperatorRequest = z.object({
  name: z.string().min(1).max(120).optional(),
  role: RoleEnum.optional(),
  disabled: z.boolean().optional(),
});

const RotatePubkeyRequest = z.object({
  ssh_pubkey: CreateOperatorRequest.shape.ssh_pubkey,
  ssh_pubkey_fp_sha256: CreateOperatorRequest.shape.ssh_pubkey_fp_sha256,
});

interface OperatorRow {
  id: string;
  name: string;
  email: string;
  ssh_pubkey: string;
  ssh_pubkey_fp_sha256: string;
  api_key_id: string;
  role: 'admin' | 'operator' | 'readonly';
  disabled_at: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
}

function publicShape(r: OperatorRow): Omit<OperatorRow, 'ssh_pubkey'> {
  const { ssh_pubkey: _omit, ...rest } = r;
  void _omit;
  return rest;
}

operators.get('/v1/admin/operators', requireScope('admin:read'), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, name, email, ssh_pubkey, ssh_pubkey_fp_sha256, api_key_id, role,
            disabled_at, created_at, updated_at, last_seen_at
     FROM operators ORDER BY created_at DESC LIMIT 500`,
  ).all<OperatorRow>();
  return c.json({ data: rows.results.map(publicShape) });
});

operators.get('/v1/admin/operators/lookup', requireScope('admin:impersonate'), async (c) => {
  const fp = c.req.query('fingerprint');
  if (!fp) return buildError(c, 'bad_request', 'fingerprint required');
  if (!SSH_FP_PATTERN.test(fp))
    return buildError(c, 'bad_request', 'fingerprint must be SHA256:<base64-no-padding>');
  const row = await c.env.DB.prepare(
    `SELECT id, name, email, ssh_pubkey, ssh_pubkey_fp_sha256, api_key_id, role,
            disabled_at, created_at, updated_at, last_seen_at
     FROM operators WHERE ssh_pubkey_fp_sha256 = ? AND disabled_at IS NULL`,
  )
    .bind(fp)
    .first<OperatorRow>();
  if (!row) return buildError(c, 'not_found', 'no active operator for that fingerprint');
  c.executionCtx.waitUntil(
    c.env.DB.prepare(`UPDATE operators SET last_seen_at = ? WHERE id = ?`)
      .bind(new Date().toISOString(), row.id)
      .run()
      .catch(() => undefined),
  );
  return c.json({ operator: publicShape(row) });
});

operators.get('/v1/admin/operators/:id', requireScope('admin:read'), async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT id, name, email, ssh_pubkey, ssh_pubkey_fp_sha256, api_key_id, role,
            disabled_at, created_at, updated_at, last_seen_at
     FROM operators WHERE id = ?`,
  )
    .bind(id)
    .first<OperatorRow>();
  if (!row) return buildError(c, 'not_found', 'operator not found');
  // Detail view returns the full authorized_keys line.
  return c.json({ operator: { ...publicShape(row), ssh_pubkey: row.ssh_pubkey } });
});

operators.post('/v1/admin/operators', requireScope('admin:rotate'), async (c) => {
  let body;
  try {
    body = CreateOperatorRequest.parse(JSON.parse(bodyText(c)));
  } catch (e) {
    return buildError(c, 'bad_request', e instanceof Error ? e.message : 'invalid body');
  }
  const dupe = await c.env.DB.prepare(
    `SELECT id FROM operators WHERE email = ? OR ssh_pubkey_fp_sha256 = ?`,
  )
    .bind(body.email, body.ssh_pubkey_fp_sha256)
    .first<{ id: string }>();
  if (dupe)
    return buildError(c, 'conflict', 'operator with that email or fingerprint already exists');

  const operatorId = ulid();
  const principalId = ulid();
  const apiKeyId = ulid();
  const secret = generateSecret();
  const hashed = await hashSecret(secret, c.env.ARGON2_PEPPER);
  const nowIso = new Date().toISOString();

  const auditInsert = await buildAuditInsert(c.env, {
    actor: actorOf(c),
    action: 'operator.create',
    target: operatorId,
    meta: {
      name: body.name,
      email: body.email,
      role: body.role,
      scopes: body.scopes,
      api_key_id: apiKeyId,
      fingerprint: body.ssh_pubkey_fp_sha256,
    },
  });
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO principals (id, mailbox_id, kind, display_name, created_at)
       VALUES (?, ?, 'operator', ?, ?)`,
    ).bind(principalId, OPERATOR_SENTINEL_MAILBOX_ID, body.name, nowIso),
    c.env.DB.prepare(
      `INSERT INTO api_keys
         (id, principal_id, prefix, secret_argon2id, scopes,
          rate_limit_per_min, status, created_at)
       VALUES (?, ?, 'pk_op_', ?, ?, ?, 'primary', ?)`,
    ).bind(
      apiKeyId,
      principalId,
      hashed,
      JSON.stringify(body.scopes),
      body.rate_limit_per_min,
      nowIso,
    ),
    c.env.DB.prepare(
      `INSERT INTO operators
         (id, name, email, ssh_pubkey, ssh_pubkey_fp_sha256, api_key_id, role,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      operatorId,
      body.name,
      body.email,
      body.ssh_pubkey,
      body.ssh_pubkey_fp_sha256,
      apiKeyId,
      body.role,
      nowIso,
      nowIso,
    ),
    auditInsert.statement,
  ]);

  await c.env.KV_KEY_CACHE.put(`plain:${apiKeyId}`, secret, { expirationTtl: 15 * 60 });
  await c.env.KV_KEY_CACHE.put(
    `key:${apiKeyId}`,
    JSON.stringify({
      id: apiKeyId,
      mailbox_id: OPERATOR_SENTINEL_MAILBOX_ID,
      principal_id: principalId,
      secret_argon2id: hashed,
      sender_scope_ids: [],
      scopes: JSON.stringify(body.scopes),
      rate_limit_per_min: body.rate_limit_per_min,
      status: 'primary',
      revoked_at: null,
    }),
    { expirationTtl: 60 },
  );

  return c.json(
    {
      operator: {
        id: operatorId,
        name: body.name,
        email: body.email,
        ssh_pubkey: body.ssh_pubkey,
        ssh_pubkey_fp_sha256: body.ssh_pubkey_fp_sha256,
        api_key_id: apiKeyId,
        role: body.role,
        disabled_at: null,
        created_at: nowIso,
        updated_at: nowIso,
        last_seen_at: null,
      },
      api_key_id: apiKeyId,
      api_key_prefix: 'pk_op_',
      api_key_secret: secret,
      // Single bearer string the new operator pastes into `polaris-email login`.
      // Format: polaris_{key_id}.{base64_secret}.
      login_token: `polaris_${apiKeyId}.${secret}`,
    },
    201,
  );
});

operators.patch('/v1/admin/operators/:id', requireScope('admin:rotate'), async (c) => {
  const id = c.req.param('id');
  let body;
  try {
    body = UpdateOperatorRequest.parse(JSON.parse(bodyText(c) || '{}'));
  } catch (e) {
    return buildError(c, 'bad_request', e instanceof Error ? e.message : 'invalid body');
  }
  const row = await c.env.DB.prepare(
    `SELECT id, api_key_id, disabled_at FROM operators WHERE id = ?`,
  )
    .bind(id)
    .first<{ id: string; api_key_id: string; disabled_at: string | null }>();
  if (!row) return buildError(c, 'not_found', 'operator not found');

  const sets: string[] = [];
  const binds: (string | null)[] = [];
  const meta: Record<string, unknown> = {};
  if (body.name !== undefined) {
    sets.push('name = ?');
    binds.push(body.name);
    meta.name = body.name;
  }
  if (body.role !== undefined) {
    sets.push('role = ?');
    binds.push(body.role);
    meta.role = body.role;
  }
  let disabledChange: 'enabled' | 'disabled' | null = null;
  if (body.disabled === true && row.disabled_at == null) {
    sets.push('disabled_at = ?');
    binds.push(new Date().toISOString());
    disabledChange = 'disabled';
    meta.disabled = true;
  } else if (body.disabled === false && row.disabled_at != null) {
    sets.push('disabled_at = NULL');
    disabledChange = 'enabled';
    meta.disabled = false;
  }
  if (sets.length === 0) return c.json({ ok: true, no_changes: true });
  sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");

  binds.push(id);
  const auditInsert = await buildAuditInsert(c.env, {
    actor: actorOf(c),
    action: disabledChange === 'disabled' ? 'operator.disable' : 'operator.update',
    target: id,
    meta,
  });
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE operators SET ${sets.join(', ')} WHERE id = ?`).bind(...binds),
    auditInsert.statement,
  ]);

  if (disabledChange === 'disabled') {
    const keyRow = await c.env.DB.prepare(`SELECT principal_id FROM api_keys WHERE id = ?`)
      .bind(row.api_key_id)
      .first<{ principal_id: string | null }>();
    await c.env.DB.prepare(`UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE id = ?`)
      .bind(new Date().toISOString(), row.api_key_id)
      .run();
    if (keyRow?.principal_id) {
      await revoke(c.env, keyRow.principal_id, [
        `plain:${row.api_key_id}`,
        `key:${row.api_key_id}`,
      ]);
    } else {
      await c.env.KV_KEY_CACHE.delete(`plain:${row.api_key_id}`);
      await c.env.KV_KEY_CACHE.delete(`key:${row.api_key_id}`);
    }
  }
  return c.json({ ok: true });
});

operators.delete('/v1/admin/operators/:id', requireScope('admin:rotate'), async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT id, api_key_id, disabled_at FROM operators WHERE id = ?`,
  )
    .bind(id)
    .first<{ id: string; api_key_id: string; disabled_at: string | null }>();
  if (!row) return buildError(c, 'not_found', 'operator not found');
  if (row.disabled_at) return c.json({ ok: true, already_disabled: true });

  const nowIso = new Date().toISOString();
  const auditInsert = await buildAuditInsert(c.env, {
    actor: actorOf(c),
    action: 'operator.disable',
    target: id,
    meta: { via: 'DELETE' },
  });
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE operators SET disabled_at = ?, updated_at = ? WHERE id = ?`).bind(
      nowIso,
      nowIso,
      id,
    ),
    c.env.DB.prepare(`UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE id = ?`).bind(
      nowIso,
      row.api_key_id,
    ),
    auditInsert.statement,
  ]);
  const keyRow = await c.env.DB.prepare(`SELECT principal_id FROM api_keys WHERE id = ?`)
    .bind(row.api_key_id)
    .first<{ principal_id: string | null }>();
  if (keyRow?.principal_id) {
    await revoke(c.env, keyRow.principal_id, [`plain:${row.api_key_id}`, `key:${row.api_key_id}`]);
  } else {
    await c.env.KV_KEY_CACHE.delete(`plain:${row.api_key_id}`);
    await c.env.KV_KEY_CACHE.delete(`key:${row.api_key_id}`);
  }
  return c.json({ ok: true, disabled_at: nowIso });
});

operators.post('/v1/admin/operators/:id/rotate-key', requireScope('admin:rotate'), async (c) => {
  const id = c.req.param('id');
  const op = await c.env.DB.prepare(
    `SELECT id, api_key_id, disabled_at FROM operators WHERE id = ?`,
  )
    .bind(id)
    .first<{ id: string; api_key_id: string; disabled_at: string | null }>();
  if (!op) return buildError(c, 'not_found', 'operator not found');
  if (op.disabled_at) return buildError(c, 'conflict', 'cannot rotate a disabled operator');
  const old = await c.env.DB.prepare(
    `SELECT principal_id, scopes, rate_limit_per_min, prefix FROM api_keys WHERE id = ?`,
  )
    .bind(op.api_key_id)
    .first<{
      principal_id: string | null;
      scopes: string;
      rate_limit_per_min: number;
      prefix: string;
    }>();
  if (!old) return buildError(c, 'not_found', 'underlying api_key missing');

  const newId = ulid();
  const newSecret = generateSecret();
  const newHashed = await hashSecret(newSecret, c.env.ARGON2_PEPPER);
  const nowIso = new Date().toISOString();
  const auditInsert = await buildAuditInsert(c.env, {
    actor: actorOf(c),
    action: 'operator.rotate_key',
    target: id,
    meta: { old_api_key_id: op.api_key_id, new_api_key_id: newId },
  });
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO api_keys
         (id, principal_id, prefix, secret_argon2id, scopes, rate_limit_per_min, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'primary', ?)`,
    ).bind(
      newId,
      old.principal_id,
      old.prefix,
      newHashed,
      old.scopes,
      old.rate_limit_per_min,
      nowIso,
    ),
    c.env.DB.prepare(`UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE id = ?`).bind(
      nowIso,
      op.api_key_id,
    ),
    c.env.DB.prepare(`UPDATE operators SET api_key_id = ?, updated_at = ? WHERE id = ?`).bind(
      newId,
      nowIso,
      id,
    ),
    auditInsert.statement,
  ]);
  if (old.principal_id) {
    await revoke(c.env, old.principal_id, [`plain:${op.api_key_id}`, `key:${op.api_key_id}`]);
  } else {
    await c.env.KV_KEY_CACHE.delete(`plain:${op.api_key_id}`);
    await c.env.KV_KEY_CACHE.delete(`key:${op.api_key_id}`);
  }
  await c.env.KV_KEY_CACHE.put(`plain:${newId}`, newSecret, { expirationTtl: 15 * 60 });
  return c.json({
    api_key_id: newId,
    api_key_prefix: old.prefix,
    api_key_secret: newSecret,
    login_token: `polaris_${newId}.${newSecret}`,
  });
});

operators.post('/v1/admin/operators/:id/rotate-pubkey', requireScope('admin:rotate'), async (c) => {
  const id = c.req.param('id');
  let body;
  try {
    body = RotatePubkeyRequest.parse(JSON.parse(bodyText(c)));
  } catch (e) {
    return buildError(c, 'bad_request', e instanceof Error ? e.message : 'invalid body');
  }
  const op = await c.env.DB.prepare(`SELECT id, disabled_at FROM operators WHERE id = ?`)
    .bind(id)
    .first<{ id: string; disabled_at: string | null }>();
  if (!op) return buildError(c, 'not_found', 'operator not found');
  if (op.disabled_at) return buildError(c, 'conflict', 'cannot rotate a disabled operator');
  const dupe = await c.env.DB.prepare(
    `SELECT id FROM operators WHERE ssh_pubkey_fp_sha256 = ? AND id <> ? AND disabled_at IS NULL`,
  )
    .bind(body.ssh_pubkey_fp_sha256, id)
    .first<{ id: string }>();
  if (dupe)
    return buildError(c, 'conflict', 'fingerprint already in use by another active operator');

  const nowIso = new Date().toISOString();
  const auditInsert = await buildAuditInsert(c.env, {
    actor: actorOf(c),
    action: 'operator.rotate_pubkey',
    target: id,
    meta: { new_fingerprint: body.ssh_pubkey_fp_sha256 },
  });
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE operators
       SET ssh_pubkey = ?, ssh_pubkey_fp_sha256 = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(body.ssh_pubkey, body.ssh_pubkey_fp_sha256, nowIso, id),
    auditInsert.statement,
  ]);
  return c.json({ ok: true });
});

export { SSH_FP_PATTERN };
