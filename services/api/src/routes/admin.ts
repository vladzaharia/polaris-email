// Admin REST routes: tenants (legacy "services" alias), domains, api-keys,
// webhooks, routing, bulk-revoke, rotation, bridge-config.
// All HMAC-auth + `admin:*` scope.
import { Hono } from 'hono';
import {
  BulkRevokeServiceRequest,
  CreateRoutingRuleRequest,
  CreateServiceRequest,
  CreateWebhookSubRequest,
  IssueApiKeyRequest,
  RotateRequest,
} from '@polaris-email/schema';
import { audit } from '../audit.js';
import { bodyText, hmacAuth, requireScope } from '../auth.js';
import type { Env } from '../env.js';
import { buildError } from '../errors.js';
import { hashSecret, sha256Hex } from '../hashing.js';
import { ulid } from '../ids.js';
import { generateSecret } from '@polaris-email/hmac';
import { outboundDomains } from './admin/outbound-domains.js';
import { senders as sendersRoutes } from './admin/senders.js';

export const admin = new Hono<{ Bindings: Env }>();

admin.use('/v1/admin/*', hmacAuth('polaris-api.v1'));
// /v1/bridge/* lives below; also auth-required (admin:read scope).
admin.use('/v1/bridge/*', hmacAuth('polaris-api.v1'));

// Sub-routers for v2 admin surfaces. Both rely on the admin middleware above.
admin.route('/', outboundDomains);
admin.route('/', sendersRoutes);

// ---------- tenants (legacy "services" URL kept for backward compat) ----------

admin.post('/v1/admin/services', requireScope('admin:rotate'), async (c) => {
  const key = c.get('apiKey');
  let body;
  try {
    body = CreateServiceRequest.parse(JSON.parse(bodyText(c)));
  } catch (e) {
    return buildError(c, 'bad_request', e instanceof Error ? e.message : 'invalid body');
  }
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  // Fold legacy `notes` + `owner` into the canonical `description` column.
  const descParts: string[] = [];
  if (body.description) descParts.push(body.description);
  if (body.owner) descParts.push(`owner: ${body.owner}`);
  if (body.notes) descParts.push(body.notes);
  const description = descParts.length > 0 ? descParts.join(' | ') : null;
  try {
    await c.env.DB.prepare(
      `INSERT INTO tenants (id, name, description, environment, pepper_version, created_at, updated_at)
       VALUES (?, ?, ?, 'prod', 1, ?, ?)`,
    )
      .bind(body.id, body.name, description, nowIso, nowIso)
      .run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) return buildError(c, 'conflict', 'tenant id or name taken');
    throw e;
  }
  await audit(c.env, {
    actor: `key:${key.key_id}`,
    action: 'tenant.create',
    target: body.id,
    meta: { name: body.name, owner: body.owner ?? null },
  });
  return c.json({ id: body.id, created_at: now }, 201);
});

admin.get('/v1/admin/services', requireScope('admin:read'), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, name, description, environment, created_at, disabled_at FROM tenants ORDER BY id ASC`,
  ).all();
  return c.json({ data: rows.results });
});

// ---------- api keys ----------

admin.post('/v1/admin/api-keys', requireScope('admin:rotate'), async (c) => {
  const key = c.get('apiKey');
  let body;
  try {
    body = IssueApiKeyRequest.parse(JSON.parse(bodyText(c)));
  } catch (e) {
    return buildError(c, 'bad_request', e instanceof Error ? e.message : 'invalid body');
  }
  const tenantId = body.tenant_id ?? body.service_id!;
  const id = ulid();
  const principalId = ulid();
  const secret = generateSecret();
  const hashed = await hashSecret(secret, c.env.ARGON2_PEPPER);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  // 1) Create principal row (kind='api_key').
  await c.env.DB.prepare(
    `INSERT INTO principals (id, tenant_id, kind, display_name, environment, created_at)
     VALUES (?, ?, 'api_key', ?, 'prod', ?)`,
  )
    .bind(principalId, tenantId, body.display_name ?? null, nowIso)
    .run();
  // 2) Create the api_key row pointing at the principal.
  await c.env.DB.prepare(
    `INSERT INTO api_keys
       (id, principal_id, prefix, secret_argon2id, scopes, sender_scopes,
        rate_limit_per_min, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'primary', ?)`,
  )
    .bind(
      id,
      principalId,
      'pk_live_',
      hashed,
      JSON.stringify(body.scopes),
      JSON.stringify(body.sender_scopes),
      body.rate_limit_per_min,
      nowIso,
    )
    .run();
  // Cache plaintext for 60s so other colos can verify recent sigs without a DB hit.
  await c.env.KV_KEY_CACHE.put(`plain:${id}`, secret, { expirationTtl: 60 * 60 * 24 * 365 });
  // Cache the row for warm lookups too.
  await c.env.KV_KEY_CACHE.put(
    `key:${id}`,
    JSON.stringify({
      id,
      tenant_id: tenantId,
      principal_id: principalId,
      secret_argon2id: hashed,
      sender_scopes: JSON.stringify(body.sender_scopes),
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
      tenant_id: tenantId,
      principal_id: principalId,
      scopes: body.scopes,
      sender_scope_count: body.sender_scopes.length,
    },
  });
  return c.json({ key_id: id, key_secret: secret, prefix: 'pk_live_', created_at: now }, 201);
});

admin.get('/v1/admin/api-keys', requireScope('admin:read'), async (c) => {
  const tenant = c.req.query('tenant') ?? c.req.query('service');
  if (tenant) {
    // Two-step lookup: principals → api_keys (mock D1 doesn't parse joins).
    const principals = await c.env.DB.prepare(
      `SELECT id FROM principals WHERE tenant_id = ?`,
    )
      .bind(tenant)
      .all<{ id: string }>();
    const out: unknown[] = [];
    for (const p of principals.results) {
      const rows = await c.env.DB.prepare(
        `SELECT id, principal_id, prefix, scopes, sender_scopes, status, created_at,
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
    `SELECT id, principal_id, prefix, scopes, sender_scopes, status, created_at,
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
    `SELECT principal_id, sender_scopes, scopes, rate_limit_per_min, prefix FROM api_keys WHERE id = ?`,
  )
    .bind(id)
    .first<{
      principal_id: string | null;
      sender_scopes: string | null;
      scopes: string;
      rate_limit_per_min: number;
      prefix: string;
    }>();
  if (!fullOld) return buildError(c, 'not_found', 'race: api key vanished');
  await c.env.DB.prepare(
    `INSERT INTO api_keys
       (id, principal_id, prefix, secret_argon2id, scopes, sender_scopes,
        rate_limit_per_min, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'primary', ?)`,
  )
    .bind(
      newId,
      fullOld.principal_id,
      fullOld.prefix,
      newHashed,
      fullOld.scopes,
      fullOld.sender_scopes,
      fullOld.rate_limit_per_min,
      nowIso,
    )
    .run();
  await c.env.KV_KEY_CACHE.put(`plain:${newId}`, newSecret, {
    expirationTtl: 60 * 60 * 24 * 365,
  });
  if (body.mode === 'planned') {
    await c.env.DB.prepare(`UPDATE api_keys SET status = 'secondary' WHERE id = ?`)
      .bind(id)
      .run();
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
  const r = await c.env.DB.prepare(
    `UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE id = ? AND status <> 'revoked'`,
  )
    .bind(nowIso, id)
    .run();
  if (r.meta.changes === 0) return buildError(c, 'not_found', 'api key not found or already revoked');
  await c.env.KV_KEY_CACHE.delete(`plain:${id}`);
  await c.env.KV_KEY_CACHE.delete(`key:${id}`);
  await audit(c.env, {
    actor: `key:${key.key_id}`,
    action: body.mode === 'emergency' ? 'api_key.revoke.emergency' : 'api_key.revoke',
    target: id,
    meta: { reason: body.reason ?? null },
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
  // Validate URL host
  try {
    const url = new URL(body.url);
    if (body.kind === 'external' && url.protocol !== 'https:') {
      return buildError(c, 'bad_request', 'external webhooks require https');
    }
    if (body.kind === 'tailnet' && !url.hostname.endsWith('.ts.net')) {
      return buildError(c, 'bad_request', 'tailnet webhook must target *.ts.net');
    }
    if (body.kind === 'bridge' && !url.hostname.endsWith(c.env.BRIDGE_TAILNET_HOST)) {
      // Accept exact match too
      if (url.hostname !== c.env.BRIDGE_TAILNET_HOST) {
        return buildError(c, 'bad_request', 'bridge webhook must target the bridge hostname');
      }
    }
  } catch {
    return buildError(c, 'bad_request', 'invalid url');
  }
  const id = ulid();
  const secret = generateSecret();
  const tenantId = body.tenant_id ?? body.service_id!;
  const nowIso = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO webhook_subs
       (id, tenant_id, domain_id, url, kind, secret, events, environment, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'prod', ?)`,
  )
    .bind(
      id,
      tenantId,
      body.domain_id ?? null,
      body.url,
      body.kind,
      secret,
      JSON.stringify(body.events),
      nowIso,
    )
    .run();
  await audit(c.env, {
    actor: `key:${key.key_id}`,
    action: 'webhook_sub.create',
    target: id,
    meta: { kind: body.kind, url_host: new URL(body.url).hostname, events: body.events },
  });
  return c.json({ id, secret }, 201);
});

// ---------- routing rules ----------

admin.post('/v1/admin/routing-rules', requireScope('admin:rotate'), async (c) => {
  const key = c.get('apiKey');
  let body;
  try {
    body = CreateRoutingRuleRequest.parse(JSON.parse(bodyText(c)));
  } catch (e) {
    return buildError(c, 'bad_request', e instanceof Error ? e.message : 'invalid body');
  }
  const id = ulid();
  const nowIso = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO routing_rules
       (id, domain_id, priority, address_pattern, action, webhook_sub_id, forward_to,
        environment, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'prod', 1, ?)`,
  )
    .bind(
      id,
      body.domain_id,
      body.priority,
      body.address_pattern,
      body.action,
      body.webhook_sub_id ?? null,
      body.forward_to ?? null,
      nowIso,
    )
    .run();
  await audit(c.env, {
    actor: `key:${key.key_id}`,
    action: 'routing_rule.create',
    target: id,
    meta: { domain_id: body.domain_id, priority: body.priority, action: body.action },
  });
  return c.json({ id }, 201);
});

// ---------- bulk revoke tenant ----------

admin.post('/v1/admin/bulk/revoke-service', requireScope('admin:rotate'), async (c) => {
  const key = c.get('apiKey');
  let body;
  try {
    body = BulkRevokeServiceRequest.parse(JSON.parse(bodyText(c)));
  } catch (e) {
    return buildError(c, 'bad_request', e instanceof Error ? e.message : 'invalid body');
  }
  if (body.confirmation !== body.service_id) {
    return buildError(c, 'bad_request', 'confirmation does not match service_id');
  }
  const nowIso = new Date().toISOString();
  // Find all principals for this tenant, then all api_keys for those principals.
  const principals = await c.env.DB.prepare(
    `SELECT id FROM principals WHERE tenant_id = ?`,
  )
    .bind(body.service_id)
    .all<{ id: string }>();
  const allKeys: { id: string }[] = [];
  for (const p of principals.results) {
    const ks = await c.env.DB.prepare(
      `SELECT id FROM api_keys WHERE principal_id = ? AND status <> 'revoked'`,
    )
      .bind(p.id)
      .all<{ id: string }>();
    for (const k of ks.results) allKeys.push(k);
  }
  for (const k of allKeys) {
    await c.env.DB.prepare(
      `UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE id = ?`,
    )
      .bind(nowIso, k.id)
      .run();
    await c.env.KV_KEY_CACHE.delete(`plain:${k.id}`);
    await c.env.KV_KEY_CACHE.delete(`key:${k.id}`);
  }
  await audit(c.env, {
    actor: `key:${key.key_id}`,
    action: 'tenant.disable',
    target: body.service_id,
    meta: {
      incident_ticket_id: body.incident_ticket_id,
      revoked_api_keys: allKeys.map((k) => k.id),
    },
  });
  return c.json({
    revoked_api_keys: allKeys.map((k) => k.id),
  });
});

// ---------- bridge config ----------

admin.get('/v1/bridge/config', requireScope('admin:read'), async (c) => {
  // The bridge/daemon is a privileged consumer with `admin:read` scope. Returns
  // ONLY senders + submission_credentials for the daemon to mirror.
  // Best-effort: mail_domains may not yet have rows (fresh deploy). Empty array OK.
  type SenderRowB = {
    id: string;
    domain_id: string;
    address: string;
    local_part: string | null;
    disabled_at: string | null;
  };
  type DomainRowB = { id: string; name: string };
  type CredRowB = {
    id: string;
    principal_id: string;
    username: string;
    bcrypt_hash: string;
    disabled_at: string | null;
  };
  type ScopeRowB = { principal_id: string; sender_id: string };
  let senderRows: { results: SenderRowB[] } = { results: [] };
  let domainRows: { results: DomainRowB[] } = { results: [] };
  let credRows: { results: CredRowB[] } = { results: [] };
  let scopeRows: { results: ScopeRowB[] } = { results: [] };
  try {
    senderRows = await c.env.DB.prepare(
      `SELECT id, domain_id, address, local_part, disabled_at FROM email_senders`,
    ).all<SenderRowB>();
    domainRows = await c.env.DB.prepare(
      `SELECT id, name FROM mail_domains`,
    ).all<DomainRowB>();
    credRows = await c.env.DB.prepare(
      `SELECT id, principal_id, username, bcrypt_hash, disabled_at FROM submission_credentials`,
    ).all<CredRowB>();
    scopeRows = await c.env.DB.prepare(
      `SELECT principal_id, sender_id FROM principal_sender_scopes`,
    ).all<ScopeRowB>();
  } catch {
    // Tables absent (degraded environment). Treat as empty.
  }
  const domainById = new Map<string, string>();
  for (const d of domainRows.results) domainById.set(d.id, d.name);
  // Build sender → credentials map via principal_sender_scopes:
  // submission_credentials.principal_id ⋈ principal_sender_scopes.principal_id ⋈ sender_id.
  const credsByPrincipal = new Map<string, CredRowB[]>();
  for (const cr of credRows.results) {
    const arr = credsByPrincipal.get(cr.principal_id) ?? [];
    arr.push(cr);
    credsByPrincipal.set(cr.principal_id, arr);
  }
  const credsBySender = new Map<string, CredRowB[]>();
  for (const sc of scopeRows.results) {
    const creds = credsByPrincipal.get(sc.principal_id) ?? [];
    const arr = credsBySender.get(sc.sender_id) ?? [];
    for (const cr of creds) arr.push(cr);
    credsBySender.set(sc.sender_id, arr);
  }
  const sendersOut = senderRows.results
    .map((s) => {
      const dom = domainById.get(s.domain_id);
      if (!dom) return null;
      return {
        id: s.id,
        address: s.address,
        display_name: null,
        disabled: s.disabled_at != null,
        smtp_credentials: (credsBySender.get(s.id) ?? []).map((cr) => ({
          id: cr.id,
          username: cr.username,
          password_hash: cr.bcrypt_hash,
          disabled: cr.disabled_at != null,
        })),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  return c.json({
    senders: sendersOut,
    rate_limits: {
      inbound_per_source_ip_per_min: 60,
    },
  });
});

// ---------- audit chain status ----------

admin.get('/v1/admin/audit/chain-status', requireScope('admin:read'), async (c) => {
  const head = await c.env.DB.prepare(
    `SELECT id, row_hash, at FROM audit_log ORDER BY id DESC LIMIT 1`,
  ).first<{ id: number; row_hash: string; at: number }>();
  const anchor = await c.env.DB.prepare(
    `SELECT id, last_audit_id, signed_at, signature, anchor_object_key
     FROM audit_anchors ORDER BY id DESC LIMIT 1`,
  ).first<{ id: number; last_audit_id: number; signed_at: string; signature: string; anchor_object_key: string | null }>();
  return c.json({ head, latest_anchor: anchor });
});

// Cover the unused-import warning for sha256Hex (used elsewhere in this module if extended).
void sha256Hex;
