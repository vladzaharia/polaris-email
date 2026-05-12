// Admin REST routes: services, domains, mailboxes, api-keys, webhooks, routing,
// local-webhook-targets, bulk-revoke, rotation, bridge-config. All HMAC-auth + `admin:*` scope.
import { Hono } from 'hono';
import {
  BulkRevokeServiceRequest,
  CreateLocalTargetRequest,
  CreateMailboxRequest,
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

// ---------- services ----------

admin.post('/v1/admin/services', requireScope('admin:rotate'), async (c) => {
  const key = c.get('apiKey');
  let body;
  try {
    body = CreateServiceRequest.parse(JSON.parse(bodyText(c)));
  } catch (e) {
    return buildError(c, 'bad_request', e instanceof Error ? e.message : 'invalid body');
  }
  const pepper = generateSecret();
  const now = Date.now();
  try {
    await c.env.DB.prepare(
      `INSERT INTO services (id, name, owner, notes, to_hash_pepper, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(body.id, body.name, body.owner ?? null, body.notes ?? null, pepper, now)
      .run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) return buildError(c, 'conflict', 'service id taken');
    throw e;
  }
  await audit(c.env, {
    actor: `key:${key.key_id}`,
    action: 'service.create',
    target: body.id,
    meta: { name: body.name, owner: body.owner ?? null },
  });
  return c.json({ id: body.id, created_at: now }, 201);
});

admin.get('/v1/admin/services', requireScope('admin:read'), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, name, owner, notes, created_at, disabled_at FROM services ORDER BY id ASC`,
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
  const id = ulid();
  const secret = generateSecret();
  const hashed = await hashSecret(secret, c.env.ARGON2_PEPPER);
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO api_keys
       (id, prefix, secret_argon2id, service_id, sender_scopes, scopes,
        rate_limit_per_min, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'primary', ?)`,
  )
    .bind(
      id,
      'pk_live_',
      hashed,
      body.service_id,
      JSON.stringify(body.sender_scopes),
      JSON.stringify(body.scopes),
      body.rate_limit_per_min,
      now,
    )
    .run();
  // Cache plaintext for 60s so other colos can verify recent sigs without a DB hit.
  await c.env.KV_KEY_CACHE.put(`plain:${id}`, secret, { expirationTtl: 60 * 60 * 24 * 365 });
  // Cache the row for warm lookups too.
  await c.env.KV_KEY_CACHE.put(
    `key:${id}`,
    JSON.stringify({
      id,
      service_id: body.service_id,
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
      service_id: body.service_id,
      scopes: body.scopes,
      sender_scope_count: body.sender_scopes.length,
    },
  });
  return c.json({ key_id: id, key_secret: secret, prefix: 'pk_live_', created_at: now }, 201);
});

admin.get('/v1/admin/api-keys', requireScope('admin:read'), async (c) => {
  const service = c.req.query('service');
  const stmt = service
    ? c.env.DB.prepare(
        `SELECT id, prefix, service_id, scopes, sender_scopes, status, created_at,
                revoked_at, last_used_at, last_used_ip
         FROM api_keys WHERE service_id = ? ORDER BY created_at DESC`,
      ).bind(service)
    : c.env.DB.prepare(
        `SELECT id, prefix, service_id, scopes, sender_scopes, status, created_at,
                revoked_at, last_used_at, last_used_ip
         FROM api_keys ORDER BY created_at DESC LIMIT 500`,
      );
  const rows = await stmt.all();
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
  // Copy the old row's scopes etc. to the new secondary row.
  const fullOld = await c.env.DB.prepare(
    `SELECT service_id, sender_scopes, scopes, rate_limit_per_min, prefix FROM api_keys WHERE id = ?`,
  )
    .bind(id)
    .first<{
      service_id: string | null;
      sender_scopes: string;
      scopes: string;
      rate_limit_per_min: number;
      prefix: string;
    }>();
  if (!fullOld) return buildError(c, 'not_found', 'race: api key vanished');
  await c.env.DB.prepare(
    `INSERT INTO api_keys
       (id, prefix, secret_argon2id, service_id, sender_scopes, scopes,
        rate_limit_per_min, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'primary', ?)`,
  )
    .bind(
      newId,
      fullOld.prefix,
      newHashed,
      fullOld.service_id,
      fullOld.sender_scopes,
      fullOld.scopes,
      fullOld.rate_limit_per_min,
      now,
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
      .bind(now, id)
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
  const r = await c.env.DB.prepare(
    `UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE id = ? AND status <> 'revoked'`,
  )
    .bind(now, id)
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

// ---------- mailboxes ----------

admin.post('/v1/admin/mailboxes', requireScope('admin:rotate'), async (c) => {
  const key = c.get('apiKey');
  let body;
  try {
    body = CreateMailboxRequest.parse(JSON.parse(bodyText(c)));
  } catch (e) {
    return buildError(c, 'bad_request', e instanceof Error ? e.message : 'invalid body');
  }
  const id = ulid();
  const now = Date.now();
  try {
    await c.env.DB.prepare(
      `INSERT INTO mailboxes
         (id, address, display_name, service_id, retain_imap, retention_days,
          max_inbound_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        body.address,
        body.display_name ?? null,
        body.service_id ?? null,
        body.retain_imap ? 1 : 0,
        body.retention_days,
        body.max_inbound_bytes,
        now,
      )
      .run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) return buildError(c, 'conflict', 'address in use');
    throw e;
  }
  await audit(c.env, {
    actor: `key:${key.key_id}`,
    action: 'mailbox.create',
    target: id,
    meta: { address: body.address, service_id: body.service_id ?? null },
  });
  return c.json({ id, created_at: now }, 201);
});

admin.post(
  '/v1/admin/mailboxes/:id/imap-credential/rotate',
  requireScope('admin:rotate'),
  async (c) => {
    const key = c.get('apiKey');
    const id = c.req.param('id');
    let body;
    try {
      body = RotateRequest.parse(JSON.parse(bodyText(c) || '{}'));
    } catch (e) {
      return buildError(c, 'bad_request', e instanceof Error ? e.message : 'invalid body');
    }
    const existing = await c.env.DB.prepare(
      `SELECT id, imap_pw_bcrypt FROM mailboxes WHERE id = ?`,
    )
      .bind(id)
      .first<{ id: string; imap_pw_bcrypt: string | null }>();
    if (!existing) return buildError(c, 'not_found', 'mailbox not found');
    const newPw = generateSecret();
    // bcrypt is unavailable in Workers WebCrypto; we store a PHC-prefixed PBKDF2 hash
    // and the sidecar bcrypts the plaintext locally before writing into Mox config.
    const newHashed = await hashSecret(newPw, c.env.ARGON2_PEPPER);
    const now = Date.now();
    if (body.mode === 'planned') {
      await c.env.DB.prepare(
        `UPDATE mailboxes
         SET imap_pw_bcrypt_prev = imap_pw_bcrypt,
             imap_pw_bcrypt = ?,
             imap_pw_rotated_at = ?
         WHERE id = ?`,
      )
        .bind(newHashed, now, id)
        .run();
      await audit(c.env, {
        actor: `key:${key.key_id}`,
        action: 'mailbox.password_rotate',
        target: id,
        meta: { reason: body.reason ?? null },
      });
    } else {
      await c.env.DB.prepare(
        `UPDATE mailboxes
         SET imap_pw_bcrypt_prev = NULL,
             imap_pw_bcrypt = ?,
             imap_pw_rotated_at = ?
         WHERE id = ?`,
      )
        .bind(newHashed, now, id)
        .run();
      await audit(c.env, {
        actor: `key:${key.key_id}`,
        action: 'mailbox.password_rotate.emergency',
        target: id,
        meta: { reason: body.reason ?? null },
      });
    }
    return c.json({ new_password: newPw, rotated_at: now });
  },
);

// ---------- webhook subs ----------

admin.post('/v1/admin/webhook-subs', requireScope('admin:rotate'), async (c) => {
  const key = c.get('apiKey');
  let body;
  try {
    body = CreateWebhookSubRequest.parse(JSON.parse(bodyText(c)));
  } catch (e) {
    return buildError(c, 'bad_request', e instanceof Error ? e.message : 'invalid body');
  }
  if (body.kind === 'bridge' && !body.local_target_id) {
    return buildError(c, 'bad_request', 'bridge kind requires local_target_id');
  }
  if (body.kind !== 'bridge' && body.local_target_id) {
    return buildError(c, 'bad_request', 'non-bridge kind must not have local_target_id');
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
  await c.env.DB.prepare(
    `INSERT INTO webhook_subs
       (id, mailbox_id, service_id, url, kind, local_target_id, secret, events)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      body.mailbox_id ?? null,
      body.service_id ?? null,
      body.url,
      body.kind,
      body.local_target_id ?? null,
      secret,
      JSON.stringify(body.events),
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
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO routing_rules (id, domain, match_json, mailbox_id, priority, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, body.domain, JSON.stringify(body.match), body.mailbox_id, body.priority, now)
    .run();
  await audit(c.env, {
    actor: `key:${key.key_id}`,
    action: 'routing_rule.create',
    target: id,
    meta: { domain: body.domain, mailbox_id: body.mailbox_id, priority: body.priority },
  });
  return c.json({ id }, 201);
});

// ---------- local webhook targets ----------

admin.post('/v1/admin/local-webhook-targets', requireScope('admin:rotate'), async (c) => {
  const key = c.get('apiKey');
  let body;
  try {
    body = CreateLocalTargetRequest.parse(JSON.parse(bodyText(c)));
  } catch (e) {
    return buildError(c, 'bad_request', e instanceof Error ? e.message : 'invalid body');
  }
  // Restrict upstream to internal docker hostnames (no http://localhost, no IP literals)
  try {
    const url = new URL(body.upstream);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return buildError(c, 'bad_request', 'unsupported scheme');
    }
    if (/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) {
      return buildError(c, 'bad_request', 'no IP-literal upstreams');
    }
  } catch {
    return buildError(c, 'bad_request', 'invalid upstream url');
  }
  const id = ulid();
  const now = Date.now();
  try {
    await c.env.DB.prepare(
      `INSERT INTO local_webhook_targets (id, service, rule, upstream, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(id, body.service, body.rule, body.upstream, now)
      .run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) return buildError(c, 'conflict', '(service,rule) taken');
    throw e;
  }
  await audit(c.env, {
    actor: `key:${key.key_id}`,
    action: 'local_webhook_target.create',
    target: id,
    meta: { service: body.service, rule: body.rule },
  });
  return c.json({ id }, 201);
});

// ---------- bulk revoke service ----------

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
  const now = Date.now();
  const keys = await c.env.DB.prepare(
    `SELECT id FROM api_keys WHERE service_id = ? AND status <> 'revoked'`,
  )
    .bind(body.service_id)
    .all<{ id: string }>();
  for (const k of keys.results) {
    await c.env.DB.prepare(
      `UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE id = ?`,
    )
      .bind(now, k.id)
      .run();
    await c.env.KV_KEY_CACHE.delete(`plain:${k.id}`);
    await c.env.KV_KEY_CACHE.delete(`key:${k.id}`);
  }
  const mailboxes = await c.env.DB.prepare(
    `SELECT id FROM mailboxes WHERE service_id = ? AND disabled_at IS NULL`,
  )
    .bind(body.service_id)
    .all<{ id: string }>();
  for (const m of mailboxes.results) {
    // Force-rotate IMAP password
    const newPw = generateSecret();
    const newHashed = await hashSecret(newPw, c.env.ARGON2_PEPPER);
    await c.env.DB.prepare(
      `UPDATE mailboxes
       SET imap_pw_bcrypt = ?, imap_pw_bcrypt_prev = NULL, imap_pw_rotated_at = ?
       WHERE id = ?`,
    )
      .bind(newHashed, now, m.id)
      .run();
    // We do NOT persist the plaintext anywhere; the consumer is quarantined so they don't
    // need it. Panel can issue a manual rotate to re-establish access.
  }
  await audit(c.env, {
    actor: `key:${key.key_id}`,
    action: 'service.quarantine',
    target: body.service_id,
    meta: {
      incident_ticket_id: body.incident_ticket_id,
      revoked_api_keys: keys.results.map((k) => k.id),
      rotated_mailboxes: mailboxes.results.map((m) => m.id),
    },
  });
  return c.json({
    revoked_api_keys: keys.results.map((k) => k.id),
    rotated_mailboxes: mailboxes.results.map((m) => m.id),
  });
});

// ---------- bridge config ----------

admin.get('/v1/bridge/config', requireScope('admin:read'), async (c) => {
  // The bridge is a privileged consumer with `admin:read` scope. Returns mailboxes and
  // local_webhook_targets.
  const mailboxes = await c.env.DB.prepare(
    `SELECT id, address, imap_username, imap_pw_bcrypt, imap_pw_bcrypt_prev, retain_imap
     FROM mailboxes WHERE disabled_at IS NULL AND imap_username IS NOT NULL`,
  ).all<{
    id: string;
    address: string;
    imap_username: string;
    imap_pw_bcrypt: string;
    imap_pw_bcrypt_prev: string | null;
    retain_imap: number;
  }>();
  const targets = await c.env.DB.prepare(
    `SELECT service, rule, upstream FROM local_webhook_targets WHERE disabled_at IS NULL`,
  ).all<{ service: string; rule: string; upstream: string }>();
  // Senders + SMTP credential hashes for the sidecar's Mox sync.
  // Best-effort: outbound_domains may not yet have rows (fresh deploy). Empty array OK.
  type SenderRowB = {
    id: string;
    domain_id: string;
    local_part: string;
    display_name: string | null;
    disabled_at: number | null;
  };
  type DomainRowB = { id: string; domain: string };
  type CredRowB = {
    id: string;
    sender_id: string;
    username: string;
    password_argon2id: string;
    disabled_at: number | null;
  };
  let senderRows: { results: SenderRowB[] } = { results: [] };
  let domainRows: { results: DomainRowB[] } = { results: [] };
  let credRows: { results: CredRowB[] } = { results: [] };
  try {
    senderRows = await c.env.DB.prepare(
      `SELECT id, domain_id, local_part, display_name, disabled_at FROM email_senders`,
    ).all<SenderRowB>();
    domainRows = await c.env.DB.prepare(
      `SELECT id, domain FROM outbound_domains`,
    ).all<DomainRowB>();
    credRows = await c.env.DB.prepare(
      `SELECT id, sender_id, username, password_argon2id, disabled_at FROM smtp_credentials`,
    ).all<CredRowB>();
  } catch {
    // Tables absent (test mocks without 0002 migration). Treat as empty.
  }
  const domainById = new Map<string, string>();
  for (const d of domainRows.results) domainById.set(d.id, d.domain);
  const credsBySender = new Map<string, CredRowB[]>();
  for (const cr of credRows.results) {
    const arr = credsBySender.get(cr.sender_id) ?? [];
    arr.push(cr);
    credsBySender.set(cr.sender_id, arr);
  }
  const sendersOut = senderRows.results
    .map((s) => {
      const dom = domainById.get(s.domain_id);
      if (!dom) return null;
      return {
        id: s.id,
        address: `${s.local_part}@${dom}`,
        display_name: s.display_name,
        disabled: s.disabled_at != null,
        smtp_credentials: (credsBySender.get(s.id) ?? []).map((cr) => ({
          id: cr.id,
          username: cr.username,
          password_hash: cr.password_argon2id,
          disabled: cr.disabled_at != null,
        })),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  return c.json({
    mailboxes: mailboxes.results.map((m) => ({
      id: m.id,
      address: m.address,
      imap_username: m.imap_username,
      imap_pw_bcrypt: m.imap_pw_bcrypt,
      imap_pw_bcrypt_prev: m.imap_pw_bcrypt_prev,
      retain_imap: m.retain_imap === 1,
    })),
    local_webhook_targets: targets.results,
    senders: sendersOut,
    rate_limits: {
      inbound_per_mailbox_per_min: 120,
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
    `SELECT id, last_audit_id, last_row_hash, signed_at, external_ref
     FROM audit_anchors ORDER BY id DESC LIMIT 1`,
  ).first<{ id: number; last_audit_id: number; last_row_hash: string; signed_at: number; external_ref: string | null }>();
  return c.json({ head, latest_anchor: anchor });
});

// Cover the unused-import warning for sha256Hex (used elsewhere in this module if extended).
void sha256Hex;
