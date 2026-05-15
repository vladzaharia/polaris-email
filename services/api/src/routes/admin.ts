// Admin REST routes: api-key issuance/rotation/revoke, webhook subs.
// Mailbox CRUD lives in `./admin/mailboxes.ts`; receiver CRUD does too
// (replaces the legacy routing_rules endpoints).
// All HMAC-auth + `admin:*` scope.
import { Hono } from 'hono';
import { CreateWebhookSubRequest, IssueApiKeyRequest, RotateRequest } from '@polaris-email/schema';
import { audit } from '../audit.js';
import { bodyText, hmacAuth, requireScope } from '../auth.js';
import type { Env } from '../env.js';
import { buildError } from '../errors.js';
import { hashSecret } from '../hashing.js';
import { ulid } from '@polaris-email/ids';
import { generateSecret } from '@polaris-email/hmac';
import { revoke } from '@polaris-email/revocation';
import { auditRoutes } from './admin/audit.js';
import { credentials } from './admin/credentials.js';
import { credentialsMailbox } from './admin/credentials-mailbox.js';
import { bridgeCredentialLookup } from './bridge/credential-lookup.js';
import { bridges } from './admin/bridges.js';
import { domains } from './admin/domains.js';
import { mailboxes as mailboxesRoutes } from './admin/mailboxes.js';
import { senders as sendersRoutes } from './admin/senders.js';
import { stats } from './admin/stats.js';
import { status } from './admin/status.js';
import { webhookDlq } from './admin/webhook-dlq.js';
import { webhookSubs } from './admin/webhook-subs.js';
import { zones } from './admin/zones.js';

export const admin = new Hono<{ Bindings: Env }>();

// /v1/admin/bootstrap signs with POLARIS_SECRET_A, not an api key — bypass hmacAuth there.
const adminHmac = hmacAuth('polaris-api');
admin.use('/v1/admin/*', async (c, next) => {
  if (c.req.path === '/v1/admin/bootstrap') return next();
  return adminHmac(c, next);
});
// /v1/bridge/* uses the same api-key HMAC.
admin.use('/v1/bridge/*', adminHmac);

// Sub-routers. All rely on the admin middleware above.
admin.route('/', mailboxesRoutes);
admin.route('/', domains);
admin.route('/', sendersRoutes);
admin.route('/', zones);
admin.route('/', bridges);
admin.route('/', credentials);
admin.route('/', credentialsMailbox);
admin.route('/', bridgeCredentialLookup);
admin.route('/', webhookDlq);
admin.route('/', webhookSubs);
admin.route('/', auditRoutes);
admin.route('/', status);
admin.route('/', stats);

// ---------- api keys ----------

admin.post('/v1/admin/api-keys', requireScope('admin:rotate'), async (c) => {
  const key = c.get('apiKey');
  let body;
  try {
    body = IssueApiKeyRequest.parse(JSON.parse(bodyText(c)));
  } catch (e) {
    return buildError(c, 'bad_request', e instanceof Error ? e.message : 'invalid body');
  }
  const mailboxId = body.mailbox_id;
  if (!mailboxId) {
    return buildError(c, 'bad_request', 'mailbox_id required');
  }
  // Verify the mailbox exists.
  const mbRow = await c.env.DB.prepare(`SELECT id FROM mailboxes WHERE id = ?`)
    .bind(mailboxId)
    .first<{ id: string }>();
  if (!mbRow) return buildError(c, 'not_found', 'mailbox not found');

  const id = ulid();
  const principalId = ulid();
  const secret = generateSecret();
  const hashed = await hashSecret(secret, c.env.ARGON2_PEPPER);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  // 1) Create principal row (kind='api_key').
  await c.env.DB.prepare(
    `INSERT INTO principals (id, mailbox_id, kind, display_name, created_at)
     VALUES (?, ?, 'api_key', ?, ?)`,
  )
    .bind(principalId, mailboxId, body.display_name ?? null, nowIso)
    .run();
  // 2) Create the api_key row pointing at the principal. No sender_scopes JSON
  //    column — scoping is via the api_key_sender_scopes junction (below).
  await c.env.DB.prepare(
    `INSERT INTO api_keys
       (id, principal_id, prefix, secret_argon2id, scopes,
        rate_limit_per_min, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'primary', ?)`,
  )
    .bind(
      id,
      principalId,
      'pk_live_',
      hashed,
      JSON.stringify(body.scopes),
      body.rate_limit_per_min,
      nowIso,
    )
    .run();
  // 3) Optional sender-scope restrictions. Empty/omitted = unrestricted.
  const senderIds = body.sender_ids ?? [];
  for (const senderId of senderIds) {
    await c.env.DB.prepare(
      `INSERT INTO api_key_sender_scopes (api_key_id, sender_id, created_at)
       VALUES (?, ?, ?)`,
    )
      .bind(id, senderId, nowIso)
      .run();
  }
  // Cache plaintext for 60s so other colos can verify recent sigs without a DB hit.
  await c.env.KV_KEY_CACHE.put(`plain:${id}`, secret, { expirationTtl: 60 * 60 * 24 * 365 });
  // Cache the row for warm lookups too.
  await c.env.KV_KEY_CACHE.put(
    `key:${id}`,
    JSON.stringify({
      id,
      mailbox_id: mailboxId,
      principal_id: principalId,
      secret_argon2id: hashed,
      sender_scope_ids: senderIds,
      scopes: JSON.stringify(body.scopes),
      rate_limit_per_min: body.rate_limit_per_min,
      status: 'primary',
      revoked_at: null,
    }),
    { expirationTtl: 60 },
  );
  await audit(c.env, {
    actor: `key:${key.key_id}`,
    action: 'api_key.issue',
    target: id,
    meta: {
      mailbox_id: mailboxId,
      principal_id: principalId,
      scopes: body.scopes,
      sender_scope_count: senderIds.length,
    },
  });
  return c.json({ key_id: id, key_secret: secret, prefix: 'pk_live_', created_at: now }, 201);
});

admin.get('/v1/admin/api-keys', requireScope('admin:read'), async (c) => {
  const mailbox = c.req.query('mailbox') ?? c.req.query('mailbox_id');
  if (mailbox) {
    // Two-step lookup: principals → api_keys (mock D1 doesn't parse joins).
    const principals = await c.env.DB.prepare(`SELECT id FROM principals WHERE mailbox_id = ?`)
      .bind(mailbox)
      .all<{ id: string }>();
    const out: unknown[] = [];
    for (const p of principals.results) {
      const rows = await c.env.DB.prepare(
        `SELECT id, principal_id, prefix, scopes, status, created_at,
                revoked_at, last_used_at, last_used_ip
         FROM api_keys WHERE principal_id = ? ORDER BY created_at DESC`,
      )
        .bind(p.id)
        .all();
      for (const r of rows.results) out.push(r);
    }
    return c.json({ data: out });
  }
  const rows = await c.env.DB.prepare(
    `SELECT id, principal_id, prefix, scopes, status, created_at,
            revoked_at, last_used_at, last_used_ip
     FROM api_keys ORDER BY created_at DESC LIMIT 500`,
  ).all();
  return c.json({ data: rows.results });
});

admin.post('/v1/admin/api-keys/:id/rotate', requireScope('admin:rotate'), async (c) => {
  const key = c.get('apiKey');
  const id = c.req.param('id');
  let body;
  try {
    body = RotateRequest.parse(JSON.parse(bodyText(c) || '{}'));
  } catch (e) {
    return buildError(c, 'bad_request', e instanceof Error ? e.message : 'invalid body');
  }
  const dryRun = c.req.query('dry_run') === '1';
  const idemHeader = c.req.header('idempotency-key');
  // Idempotency on rotation: replay returns "already_rotated", NOT the secret.
  if (idemHeader) {
    const k = `idem-rot:${key.key_id}:${idemHeader}`;
    const prev = await c.env.KV_IDEMPOTENCY.get(k);
    if (prev) {
      await audit(c.env, {
        actor: `key:${key.key_id}`,
        action: 'api_key.rotate',
        target: id,
        meta: { replay: true, idem: idemHeader },
      });
      return c.json({ status: 'already_rotated', at: Number(prev) });
    }
  }
  const existing = await c.env.DB.prepare(`SELECT id, status FROM api_keys WHERE id = ?`)
    .bind(id)
    .first<{ id: string; status: string }>();
  if (!existing) return buildError(c, 'not_found', 'api key not found');
  if (existing.status === 'revoked') return buildError(c, 'conflict', 'key already revoked');

  if (dryRun) {
    await audit(c.env, {
      actor: `key:${key.key_id}`,
      action: 'dry_run_rotate',
      target: id,
      meta: { mode: body.mode },
    });
    return c.json({ dry_run: true, would_affect: 1, target: id });
  }
  const newId = ulid();
  const newSecret = generateSecret();
  const newHashed = await hashSecret(newSecret, c.env.ARGON2_PEPPER);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  // Copy the old row's scopes etc. to the new secondary row.
  const fullOld = await c.env.DB.prepare(
    `SELECT principal_id, scopes, rate_limit_per_min, prefix FROM api_keys WHERE id = ?`,
  )
    .bind(id)
    .first<{
      principal_id: string | null;
      scopes: string;
      rate_limit_per_min: number;
      prefix: string;
    }>();
  if (!fullOld) return buildError(c, 'not_found', 'race: api key vanished');
  await c.env.DB.prepare(
    `INSERT INTO api_keys
       (id, principal_id, prefix, secret_argon2id, scopes,
        rate_limit_per_min, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'primary', ?)`,
  )
    .bind(
      newId,
      fullOld.principal_id,
      fullOld.prefix,
      newHashed,
      fullOld.scopes,
      fullOld.rate_limit_per_min,
      nowIso,
    )
    .run();
  // Copy sender-scope junction rows so the rotated key inherits restrictions.
  const oldScopes = await c.env.DB.prepare(
    `SELECT sender_id FROM api_key_sender_scopes WHERE api_key_id = ?`,
  )
    .bind(id)
    .all<{ sender_id: string }>()
    .catch(() => ({ results: [] as { sender_id: string }[] }));
  for (const s of oldScopes.results ?? []) {
    await c.env.DB.prepare(
      `INSERT INTO api_key_sender_scopes (api_key_id, sender_id, created_at)
       VALUES (?, ?, ?)`,
    )
      .bind(newId, s.sender_id, nowIso)
      .run();
  }
  await c.env.KV_KEY_CACHE.put(`plain:${newId}`, newSecret, {
    expirationTtl: 60 * 60 * 24 * 365,
  });
  if (body.mode === 'planned') {
    await c.env.DB.prepare(`UPDATE api_keys SET status = 'secondary' WHERE id = ?`).bind(id).run();
    await audit(c.env, {
      actor: `key:${key.key_id}`,
      action: 'api_key.rotate',
      target: id,
      meta: { new_id: newId, mode: 'planned', reason: body.reason ?? null },
    });
  } else {
    await c.env.DB.prepare(`UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE id = ?`)
      .bind(nowIso, id)
      .run();
    await c.env.KV_KEY_CACHE.delete(`plain:${id}`);
    await c.env.KV_KEY_CACHE.delete(`key:${id}`);
    await audit(c.env, {
      actor: `key:${key.key_id}`,
      action: 'api_key.rotate.emergency',
      target: id,
      meta: { new_id: newId, reason: body.reason ?? null },
    });
  }
  if (idemHeader) {
    await c.env.KV_IDEMPOTENCY.put(`idem-rot:${key.key_id}:${idemHeader}`, String(now), {
      expirationTtl: 60 * 60 * 24,
    });
  }
  return c.json({ new_key_id: newId, new_key_secret: newSecret, prev_status: body.mode });
});

admin.post('/v1/admin/api-keys/:id/revoke', requireScope('admin:rotate'), async (c) => {
  const key = c.get('apiKey');
  const id = c.req.param('id');
  let body;
  try {
    body = RotateRequest.parse(JSON.parse(bodyText(c) || '{}'));
  } catch (e) {
    return buildError(c, 'bad_request', e instanceof Error ? e.message : 'invalid body');
  }
  const dryRun = c.req.query('dry_run') === '1';
  if (dryRun) {
    await audit(c.env, {
      actor: `key:${key.key_id}`,
      action: 'dry_run_rotate',
      target: id,
      meta: { mode: body.mode, op: 'revoke' },
    });
    return c.json({ dry_run: true, target: id });
  }
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  // Look up the principal_id so we can stamp the revocation Durable Object.
  const keyRow = await c.env.DB.prepare(`SELECT principal_id FROM api_keys WHERE id = ?`)
    .bind(id)
    .first<{ principal_id: string }>();
  const r = await c.env.DB.prepare(
    `UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE id = ? AND status <> 'revoked'`,
  )
    .bind(nowIso, id)
    .run();
  if (r.meta.changes === 0)
    return buildError(c, 'not_found', 'api key not found or already revoked');
  await c.env.KV_KEY_CACHE.delete(`plain:${id}`);
  await c.env.KV_KEY_CACHE.delete(`key:${id}`);
  if (keyRow?.principal_id) {
    // Stamp KV_REVOCATIONS so generic HMAC auth (auth.ts) and the
    // RFC822 send path both see the revocation immediately, even if
    // KV_KEY_CACHE entries linger in another colo.
    await revoke(c.env, keyRow.principal_id);
  }
  await audit(c.env, {
    actor: `key:${key.key_id}`,
    action: body.mode === 'emergency' ? 'api_key.revoke.emergency' : 'api_key.revoke',
    target: id,
    meta: { reason: body.reason ?? null, principal_id: keyRow?.principal_id ?? null },
  });
  return c.json({ revoked_at: now });
});

// ---------- webhook subs ----------

admin.post('/v1/admin/webhook-subs', requireScope('admin:rotate'), async (c) => {
  const key = c.get('apiKey');
  let body;
  try {
    body = CreateWebhookSubRequest.parse(JSON.parse(bodyText(c)));
  } catch (e) {
    return buildError(c, 'bad_request', e instanceof Error ? e.message : 'invalid body');
  }
  if (!body.mailbox_id) {
    return buildError(c, 'bad_request', 'mailbox_id required');
  }
  // Validate URL host
  try {
    const url = new URL(body.url);
    if (body.kind === 'external' && url.protocol !== 'https:') {
      return buildError(c, 'bad_request', 'external webhooks require https');
    }
    if (body.kind === 'tailnet' && !url.hostname.endsWith('.ts.net')) {
      return buildError(c, 'bad_request', 'tailnet webhook must target *.ts.net');
    }
  } catch {
    return buildError(c, 'bad_request', 'invalid url');
  }
  const id = ulid();
  const secret = generateSecret();
  const nowIso = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO webhook_subs
       (id, mailbox_id, url, kind, secret, events, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, body.mailbox_id, body.url, body.kind, secret, JSON.stringify(body.events), nowIso)
    .run();
  await audit(c.env, {
    actor: `key:${key.key_id}`,
    action: 'webhook_sub.create',
    target: id,
    meta: {
      mailbox_id: body.mailbox_id,
      kind: body.kind,
      url_host: new URL(body.url).hostname,
      events: body.events,
    },
  });
  return c.json({ id, secret }, 201);
});

// ---------- bridge credential mirror ----------

admin.get('/v1/bridge/credentials', requireScope('admin:read'), async (c) => {
  // The submission bridge polls this endpoint to mirror SMTP credentials
  // locally. Returns a delta-style payload:
  //   { updates: Credential[], deletions: string[], mirror_version: number }
  // Where Credential is { id, username, bcrypt_hash, allowed_senders, mirror_version, ... }.
  // The `since` query param is accepted for forward-compat but currently we always
  // return the full active set — the bridge's UpsertBatch + DeleteByID handle
  // reconciliation idempotently.
  //
  // Submission credentials are 1:1 with mailbox_senders via
  // `submission_credentials.sender_id` per the canonical schema. The
  // `allowed_senders` array surfaces that single bound address.
  type CredRow = {
    id: string;
    principal_id: string;
    sender_id: string | null;
    username: string;
    bcrypt_hash: string;
    disabled_at: string | null;
    last_used_at: string | null;
  };
  type SenderRow = { id: string; address: string };
  let credRows: { results: CredRow[] } = { results: [] };
  let senderRows: { results: SenderRow[] } = { results: [] };
  try {
    credRows = await c.env.DB.prepare(
      `SELECT id, principal_id, sender_id, username, bcrypt_hash, disabled_at, last_used_at
       FROM submission_credentials`,
    ).all<CredRow>();
    senderRows = await c.env.DB.prepare(`SELECT id, address FROM mailbox_senders`).all<SenderRow>();
  } catch {
    // Tables absent (degraded environment). Treat as empty.
  }
  const senderAddrById = new Map<string, string>();
  for (const s of senderRows.results) senderAddrById.set(s.id, s.address);
  const mirrorVersion = Date.now();
  const updates = credRows.results
    .filter((r) => r.disabled_at == null)
    .map((r) => ({
      id: r.id,
      username: r.username,
      bcrypt_hash: r.bcrypt_hash,
      allowed_senders: r.sender_id ? [senderAddrById.get(r.sender_id) ?? ''].filter(Boolean) : [],
      mirror_version: mirrorVersion,
    }));
  const deletions = credRows.results.filter((r) => r.disabled_at != null).map((r) => r.id);
  return c.json({ updates, deletions, mirror_version: mirrorVersion });
});
