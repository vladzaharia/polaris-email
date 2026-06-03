// Admin REST routes: api-key issuance/rotation/revoke, webhook subs.
// Mailbox CRUD lives in `./admin/mailboxes.ts`; receiver CRUD does too
// (replaces the legacy routing_rules endpoints).
// All HMAC-auth + `admin:*` scope.
import { Hono } from 'hono';
import { CreateWebhookSubRequest, IssueApiKeyRequest, RotateRequest } from '@polaris-mail/schema';
import { actorOf, audit, buildAuditInsert } from '../audit.js';
import { bodyText, hmacAuth, requireScope } from '../auth.js';
import type { Env } from '../env.js';
import { buildError } from '../errors.js';
import { hashSecret } from '../hashing.js';
import { ulid } from '@polaris-mail/ids';
import { generateSecret } from '@polaris-mail/hmac';
import { revoke } from '@polaris-mail/revocation';
import { validateWebhookUrl } from '../lib/webhook-url.js';
import { auditRoutes } from './admin/audit.js';
import { mailboxCredentials } from './admin/mailbox-credentials.js';
import { bridgeCredentialLookup } from './bridge/credential-lookup.js';
import { bridges } from './admin/bridges.js';
import { cfZones } from './admin/cf-zones.js';
import { domains } from './admin/domains.js';
import { domainsMtaSts } from './admin/domains-mta-sts.js';
import { mailboxes as mailboxesRoutes } from './admin/mailboxes.js';
import { senders as sendersRoutes } from './admin/senders.js';
import { stats } from './admin/stats.js';
import { metrics } from './admin/metrics.js';
import { status } from './admin/status.js';
import { abuseEvents } from './admin/abuse-events.js';
import { alerts as adminAlerts } from './admin/alerts.js';
import { dmarcReports } from './admin/dmarc-reports.js';
import { dmarcPromotion } from './admin/dmarc-promotion.js';
import { moderation } from './admin/moderation.js';
import { operators } from './admin/operators.js';
import { senderAbuse } from './admin/sender-abuse.js';
import { suppressions } from './admin/suppressions.js';
import { syntheticRuns } from './admin/synthetic-runs.js';
import { tlsRptReports } from './admin/tls-rpt-reports.js';
import { triageEvents } from './admin/triage-events.js';
import { webhookDlq } from './admin/webhook-dlq.js';
import { webhookSubs } from './admin/webhook-subs.js';
import { zones } from './admin/zones.js';

export const admin = new Hono<{ Bindings: Env }>();

// /v1/admin/bootstrap signs with POLARIS_SECRET_A, not an api key — bypass hmacAuth there.
// /v1/admin/setup/webauthn/* uses the unguessable one-time code as its
// auth boundary (GET poll is public; POST .../complete verifies inline
// with the freshly minted admin key, since the key won't be in
// api_keys for the global hmacAuth lookup until *after* the genesis
// row settles).
const adminHmac = hmacAuth('polaris-api');
admin.use('/v1/admin/*', async (c, next) => {
  if (c.req.path === '/v1/admin/bootstrap') return next();
  if (c.req.path.startsWith('/v1/admin/setup/webauthn/')) return next();
  return adminHmac(c, next);
});
// /v1/bridge/* uses the same api-key HMAC.
//
// Exceptions: /v1/bridge/heartbeat and /v1/bridge/config authenticate
// with the per-bridge HMAC key (NOT an admin api key) so their per-
// bridge attribution can't be spoofed by anything that happens to hold
// `imap_bridge:read`. Handled by the `bridgeHeartbeat` / `bridgeConfig`
// sub-routers mounted in `services/api/src/index.ts`; we just need to
// step out of the way here.
admin.use('/v1/bridge/*', async (c, next) => {
  if (
    c.req.path === '/v1/bridge/heartbeat' ||
    c.req.path === '/v1/bridge/config' ||
    c.req.path === '/v1/bridge/credentials'
  )
    return next();
  return adminHmac(c, next);
});

// Sub-routers. All rely on the admin middleware above.
admin.route('/', mailboxesRoutes);
admin.route('/', domains);
admin.route('/', domainsMtaSts);
admin.route('/', sendersRoutes);
admin.route('/', zones);
admin.route('/', cfZones);
admin.route('/', bridges);
admin.route('/', mailboxCredentials);
admin.route('/', bridgeCredentialLookup);
admin.route('/', webhookDlq);
admin.route('/', webhookSubs);
admin.route('/', auditRoutes);
admin.route('/', status);
admin.route('/', stats);
admin.route('/', metrics);
admin.route('/', suppressions);
admin.route('/', abuseEvents);
admin.route('/', adminAlerts);
admin.route('/', senderAbuse);
admin.route('/', tlsRptReports);
admin.route('/', dmarcReports);
admin.route('/', dmarcPromotion);
admin.route('/', moderation);
admin.route('/', operators);
admin.route('/', syntheticRuns);
admin.route('/', triageEvents);

// ---------- api keys ----------

admin.post('/v1/admin/api-keys', requireScope('admin:rotate'), async (c) => {
  let body;
  try {
    body = IssueApiKeyRequest.parse(JSON.parse(bodyText(c)));
  } catch (e) {
    return buildError(c, 'bad_request', e instanceof Error ? e.message : 'invalid body');
  }
  // After the operators-split refactor, every api_key belongs to an
  // operator. This endpoint mints a synthetic service operator + its key
  // in one shot — kept for test-setup callers and one-off non-human
  // integrations. For human operators, prefer POST /v1/admin/operators
  // (which carries ssh_pubkey + email + role).
  const id = ulid();
  const operatorId = ulid();
  const secret = generateSecret();
  const hashed = await hashSecret(secret, c.env.ARGON2_PEPPER);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const displayName = body.display_name ?? `service-key-${id.slice(-8)}`;
  const auditInsert = await buildAuditInsert(c.env, {
    actor: actorOf(c),
    action: 'api_key.issue',
    target: id,
    meta: {
      operator_id: operatorId,
      scopes: body.scopes,
    },
  });
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO operators
         (id, name, email, ssh_pubkey, ssh_pubkey_fp_sha256, role,
          created_at, updated_at)
       VALUES (?, ?, ?, '', ?, 'operator', ?, ?)`,
    ).bind(
      operatorId,
      displayName,
      `${operatorId}@service.invalid`,
      `sha256:service-${operatorId}`,
      nowIso,
      nowIso,
    ),
    c.env.DB.prepare(
      `INSERT INTO api_keys
         (id, operator_id, prefix, secret_argon2id, scopes,
          rate_limit_per_min, status, created_at)
       VALUES (?, ?, 'pk_op_', ?, ?, ?, 'primary', ?)`,
    ).bind(id, operatorId, hashed, JSON.stringify(body.scopes), body.rate_limit_per_min, nowIso),
    auditInsert.statement,
  ]);
  await c.env.KV_KEY_CACHE.put(`plain:${id}`, secret, { expirationTtl: 15 * 60 });
  await c.env.KV_KEY_CACHE.put(
    `key:${id}`,
    JSON.stringify({
      id,
      operator_id: operatorId,
      secret_argon2id: hashed,
      scopes: JSON.stringify(body.scopes),
      rate_limit_per_min: body.rate_limit_per_min,
      status: 'primary',
      revoked_at: null,
    }),
    { expirationTtl: 60 },
  );
  return c.json({ key_id: id, key_secret: secret, prefix: 'pk_op_', created_at: now }, 201);
});

admin.get('/v1/admin/api-keys', requireScope('admin:read'), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, operator_id, prefix, scopes, status, created_at,
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
        actor: actorOf(c),
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
      actor: actorOf(c),
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
    `SELECT operator_id, scopes, rate_limit_per_min, prefix FROM api_keys WHERE id = ?`,
  )
    .bind(id)
    .first<{
      operator_id: string;
      scopes: string;
      rate_limit_per_min: number;
      prefix: string;
    }>();
  if (!fullOld) return buildError(c, 'not_found', 'race: api key vanished');
  // Build the audit insert before the batch; CAS guard runs inside the batch.
  const auditInsert = await buildAuditInsert(c.env, {
    actor: actorOf(c),
    action: body.mode === 'planned' ? 'api_key.rotate' : 'api_key.rotate.emergency',
    target: id,
    meta:
      body.mode === 'planned'
        ? { new_id: newId, mode: 'planned', reason: body.reason ?? null }
        : { new_id: newId, reason: body.reason ?? null },
  });
  // Fold every D1 mutation for this rotation into one batch:
  //   1) api_keys INSERT for the new primary
  //   2) api_keys UPDATE on the old key (status flip — the irreversible
  //      transition that MUST chain to the audit row)
  //   3) audit_log INSERT (CAS)
  const stmts = [
    c.env.DB.prepare(
      `INSERT INTO api_keys
         (id, operator_id, prefix, secret_argon2id, scopes,
          rate_limit_per_min, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'primary', ?)`,
    ).bind(
      newId,
      fullOld.operator_id,
      fullOld.prefix,
      newHashed,
      fullOld.scopes,
      fullOld.rate_limit_per_min,
      nowIso,
    ),
  ];
  if (body.mode === 'planned') {
    stmts.push(c.env.DB.prepare(`UPDATE api_keys SET status = 'secondary' WHERE id = ?`).bind(id));
  } else {
    stmts.push(
      c.env.DB.prepare(`UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE id = ?`).bind(
        nowIso,
        id,
      ),
    );
  }
  stmts.push(auditInsert.statement);
  await c.env.DB.batch(stmts);
  await c.env.KV_KEY_CACHE.put(`plain:${newId}`, newSecret, {
    expirationTtl: 15 * 60,
  });
  if (body.mode !== 'planned') {
    await c.env.KV_KEY_CACHE.delete(`plain:${id}`);
    await c.env.KV_KEY_CACHE.delete(`key:${id}`);
  }
  if (idemHeader) {
    await c.env.KV_IDEMPOTENCY.put(`idem-rot:${key.key_id}:${idemHeader}`, String(now), {
      expirationTtl: 60 * 60 * 24,
    });
  }
  return c.json({ new_key_id: newId, new_key_secret: newSecret, prev_status: body.mode });
});

admin.post('/v1/admin/api-keys/:id/revoke', requireScope('admin:rotate'), async (c) => {
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
      actor: actorOf(c),
      action: 'dry_run_rotate',
      target: id,
      meta: { mode: body.mode, op: 'revoke' },
    });
    return c.json({ dry_run: true, target: id });
  }
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  // Look up the operator_id so we can stamp KV_REVOCATIONS.
  const keyRow = await c.env.DB.prepare(`SELECT operator_id FROM api_keys WHERE id = ?`)
    .bind(id)
    .first<{ operator_id: string }>();
  // Pre-flight: confirm the key isn't already revoked. The CAS in the batch
  // below also enforces this (`status <> 'revoked'` ⇒ changes=0 on replay),
  // but we surface the 404 separately since the audit row should not be
  // emitted for a no-op.
  const preflight = await c.env.DB.prepare(
    `SELECT id FROM api_keys WHERE id = ? AND status <> 'revoked'`,
  )
    .bind(id)
    .first<{ id: string }>();
  if (!preflight) return buildError(c, 'not_found', 'api key not found or already revoked');
  // Fold the api_keys UPDATE + audit_log INSERT into one batch so a Worker
  // eviction between them can't leave a revoked key without an audit row.
  const auditInsert = await buildAuditInsert(c.env, {
    actor: actorOf(c),
    action: body.mode === 'emergency' ? 'api_key.revoke.emergency' : 'api_key.revoke',
    target: id,
    meta: { reason: body.reason ?? null, operator_id: keyRow?.operator_id ?? null },
  });
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE id = ? AND status <> 'revoked'`,
    ).bind(nowIso, id),
    auditInsert.statement,
  ]);
  if (keyRow?.operator_id) {
    // KV_KEY_CACHE busting is bundled into `revoke()` so the two writes
    // can't drift out of sync (forgetting either side leaves a 60s
    // window where a revoked key still authenticates). Stamps
    // KV_REVOCATIONS keyed by operator_id so auth.ts sees the
    // revocation immediately, even if KV_KEY_CACHE entries linger in
    // another colo.
    await revoke(c.env, keyRow.operator_id, [`plain:${id}`, `key:${id}`]);
  } else {
    // No operator — should not happen post-migration; fall back to
    // deleting the cache entries directly.
    await c.env.KV_KEY_CACHE.delete(`plain:${id}`);
    await c.env.KV_KEY_CACHE.delete(`key:${id}`);
  }
  return c.json({ revoked_at: now });
});

// ---------- webhook subs ----------

admin.post('/v1/admin/webhook-subs', requireScope('admin:rotate'), async (c) => {
  let body;
  try {
    body = CreateWebhookSubRequest.parse(JSON.parse(bodyText(c)));
  } catch (e) {
    return buildError(c, 'bad_request', e instanceof Error ? e.message : 'invalid body');
  }
  if (!body.mailbox_id) {
    return buildError(c, 'bad_request', 'mailbox_id required');
  }
  const urlErr = validateWebhookUrl(body.url, body.kind);
  if (urlErr) return buildError(c, 'bad_request', urlErr);
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
    actor: actorOf(c),
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
