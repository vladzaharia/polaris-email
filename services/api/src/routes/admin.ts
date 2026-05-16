// Admin REST routes: api-key issuance/rotation/revoke, webhook subs.
// Mailbox CRUD lives in `./admin/mailboxes.ts`; receiver CRUD does too
// (replaces the legacy routing_rules endpoints).
// All HMAC-auth + `admin:*` scope.
import { Hono } from 'hono';
import { CreateWebhookSubRequest, IssueApiKeyRequest, RotateRequest } from '@polaris-email/schema';
import { audit, buildAuditInsert } from '../audit.js';
import { bodyText, hmacAuth, requireScope } from '../auth.js';
import type { Env } from '../env.js';
import { buildError } from '../errors.js';
import { hashSecret } from '../hashing.js';
import { ulid } from '@polaris-email/ids';
import { generateSecret } from '@polaris-email/hmac';
import { revoke } from '@polaris-email/revocation';
import { validateWebhookUrl } from '../lib/webhook-url.js';
import { auditRoutes } from './admin/audit.js';
import { credentials } from './admin/credentials.js';
import { credentialsMailbox } from './admin/credentials-mailbox.js';
import { bridgeCredentialLookup } from './bridge/credential-lookup.js';
import { bridges } from './admin/bridges.js';
import { cfZones } from './admin/cf-zones.js';
import { domains } from './admin/domains.js';
import { domainsMtaSts } from './admin/domains-mta-sts.js';
import { mailboxes as mailboxesRoutes } from './admin/mailboxes.js';
import { senders as sendersRoutes } from './admin/senders.js';
import { stats } from './admin/stats.js';
import { status } from './admin/status.js';
import { abuseEvents } from './admin/abuse-events.js';
import { alerts as adminAlerts } from './admin/alerts.js';
import { senderAbuse } from './admin/sender-abuse.js';
import { suppressions } from './admin/suppressions.js';
import { tlsRptReports } from './admin/tls-rpt-reports.js';
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
admin.route('/', domainsMtaSts);
admin.route('/', sendersRoutes);
admin.route('/', zones);
admin.route('/', cfZones);
admin.route('/', bridges);
admin.route('/', credentials);
admin.route('/', credentialsMailbox);
admin.route('/', bridgeCredentialLookup);
admin.route('/', webhookDlq);
admin.route('/', webhookSubs);
admin.route('/', auditRoutes);
admin.route('/', status);
admin.route('/', stats);
admin.route('/', suppressions);
admin.route('/', abuseEvents);
admin.route('/', adminAlerts);
admin.route('/', senderAbuse);
admin.route('/', tlsRptReports);

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
  const senderIds = body.sender_ids ?? [];
  // Fold every D1 mutation for this issuance into one batch:
  //   1) principals INSERT
  //   2) api_keys INSERT (the primary mutation)
  //   3) api_key_sender_scopes INSERTs (one per scope)
  //   4) audit_log INSERT (CAS)
  // CF Workers may evict between awaits; if the api_keys INSERT lands but
  // the audit row doesn't, the chain has a hole the issuance can never
  // re-fill. Batching makes them atomic at the D1 layer.
  const auditInsert = await buildAuditInsert(c.env, {
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
  const stmts = [
    c.env.DB.prepare(
      `INSERT INTO principals (id, mailbox_id, kind, display_name, created_at)
       VALUES (?, ?, 'api_key', ?, ?)`,
    ).bind(principalId, mailboxId, body.display_name ?? null, nowIso),
    c.env.DB.prepare(
      `INSERT INTO api_keys
         (id, principal_id, prefix, secret_argon2id, scopes,
          rate_limit_per_min, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'primary', ?)`,
    ).bind(
      id,
      principalId,
      'pk_live_',
      hashed,
      JSON.stringify(body.scopes),
      body.rate_limit_per_min,
      nowIso,
    ),
  ];
  for (const senderId of senderIds) {
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO api_key_sender_scopes (api_key_id, sender_id, created_at)
         VALUES (?, ?, ?)`,
      ).bind(id, senderId, nowIso),
    );
  }
  stmts.push(auditInsert.statement);
  await c.env.DB.batch(stmts);
  // Phase 3c — cache plaintext for 1h. The api_keys row stores only an
  // argon2 hash; we can't re-derive the plaintext, so the operator's
  // window to install the secret is bounded by this TTL. 1h matches the
  // bridge plaintext convention (`bridge_plain:` in bridge-auth.ts) and
  // is a deliberate trade-off: long enough to absorb client-side
  // propagation hiccups, short enough that a leaked KV snapshot doesn't
  // grant indefinite key-recovery.
  await c.env.KV_KEY_CACHE.put(`plain:${id}`, secret, { expirationTtl: 60 * 60 });
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
  // Pre-fetch sender-scope junction rows so we can fold them into the batch.
  const oldScopes = await c.env.DB.prepare(
    `SELECT sender_id FROM api_key_sender_scopes WHERE api_key_id = ?`,
  )
    .bind(id)
    .all<{ sender_id: string }>()
    .catch(() => ({ results: [] as { sender_id: string }[] }));
  // Build the audit insert before the batch; CAS guard runs inside the batch.
  const auditInsert = await buildAuditInsert(c.env, {
    actor: `key:${key.key_id}`,
    action: body.mode === 'planned' ? 'api_key.rotate' : 'api_key.rotate.emergency',
    target: id,
    meta:
      body.mode === 'planned'
        ? { new_id: newId, mode: 'planned', reason: body.reason ?? null }
        : { new_id: newId, reason: body.reason ?? null },
  });
  // Fold every D1 mutation for this rotation into one batch:
  //   1) api_keys INSERT for the new primary
  //   2) api_key_sender_scopes INSERTs (inherit restrictions)
  //   3) api_keys UPDATE on the old key (status flip — this is the
  //      irreversible state transition we MUST chain to the audit row)
  //   4) audit_log INSERT (CAS)
  const stmts = [
    c.env.DB.prepare(
      `INSERT INTO api_keys
         (id, principal_id, prefix, secret_argon2id, scopes,
          rate_limit_per_min, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'primary', ?)`,
    ).bind(
      newId,
      fullOld.principal_id,
      fullOld.prefix,
      newHashed,
      fullOld.scopes,
      fullOld.rate_limit_per_min,
      nowIso,
    ),
  ];
  for (const s of oldScopes.results ?? []) {
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO api_key_sender_scopes (api_key_id, sender_id, created_at)
         VALUES (?, ?, ?)`,
      ).bind(newId, s.sender_id, nowIso),
    );
  }
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
    expirationTtl: 60 * 60,
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
    actor: `key:${key.key_id}`,
    action: body.mode === 'emergency' ? 'api_key.revoke.emergency' : 'api_key.revoke',
    target: id,
    meta: { reason: body.reason ?? null, principal_id: keyRow?.principal_id ?? null },
  });
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE id = ? AND status <> 'revoked'`,
    ).bind(nowIso, id),
    auditInsert.statement,
  ]);
  if (keyRow?.principal_id) {
    // Phase 3g — KV_KEY_CACHE busting is now bundled into `revoke()` so
    // these two writes can't drift out of sync (forgetting either side
    // leaves a 60s window where a "revoked" key still authenticates).
    // Stamps KV_REVOCATIONS so generic HMAC auth (auth.ts) and the
    // RFC822 send path both see the revocation immediately, even if
    // KV_KEY_CACHE entries linger in another colo.
    await revoke(c.env, keyRow.principal_id, [`plain:${id}`, `key:${id}`]);
  } else {
    // No principal — fall back to deleting the cache entries directly.
    await c.env.KV_KEY_CACHE.delete(`plain:${id}`);
    await c.env.KV_KEY_CACHE.delete(`key:${id}`);
  }
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
