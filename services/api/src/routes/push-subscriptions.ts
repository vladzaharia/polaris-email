// JMAP push subscription CRUD (Phase L slice L.4).
//
// The JMAP server inside `apps/mail-bridge` calls these endpoints when a JMAP
// client invokes `PushSubscription/set`. Auth: tenant api_key HMAC scoped to
// the owning mailbox, or daemon HMAC. The mailbox_id in the URL must match
// the api_key's bound principal mailbox.
import { Hono, type Context } from 'hono';
import { ulid } from '@polaris-email/ids';
import { JmapPushType } from '@polaris-email/schema';
import { verify } from '@polaris-email/hmac';
import { buildError } from '../errors.js';
import type { Env } from '../env.js';

export const pushSubscriptions = new Hono<{ Bindings: Env }>();

interface Caller {
  kind: 'api_key' | 'daemon';
  key_id: string;
  mailbox_id: string | null;
  isBridge: boolean;
}

type Ctx = Context<{ Bindings: Env }>;

async function authenticate(c: Ctx, bodyBytes: Uint8Array): Promise<Caller | Response> {
  const env = c.env;
  const keyId = c.req.header('x-polaris-key-id');
  const daemonId = c.req.header('x-polaris-daemon-id');
  if (daemonId && !keyId) {
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(daemonId)) {
      return buildError(c, 'unauthorized', 'invalid daemon_id format');
    }
    if (!env.DAEMON_HMAC_KEY) {
      return buildError(c, 'unauthorized', 'daemon auth not configured');
    }
    const url = new URL(c.req.url);
    const r = await verify({
      direction: 'polaris-api.v1',
      method: c.req.method,
      path: url.pathname,
      query: url.search.slice(1),
      headers: { get: (n: string) => c.req.header(n) ?? null },
      body: bodyBytes,
      secret: env.DAEMON_HMAC_KEY,
    });
    if (!r.ok) return buildError(c, 'unauthorized', `daemon HMAC: ${r.code}`);
    return { kind: 'daemon', key_id: daemonId, mailbox_id: null, isBridge: true };
  }
  if (!keyId) {
    return buildError(c, 'unauthorized', 'X-Polaris-Key-Id or X-Polaris-Daemon-Id required');
  }
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(keyId)) {
    return buildError(c, 'unauthorized', 'invalid key id format');
  }
  // Lightweight key validation (full HMAC verification handled by middleware
  // on the admin path; this is a tenant-facing path, so we replicate the
  // standard tenant verification using the cached plaintext).
  const keyRow = await env.DB.prepare(
    `SELECT id, principal_id, scopes, status, revoked_at FROM api_keys WHERE id = ?`,
  )
    .bind(keyId)
    .first<{
      id: string;
      principal_id: string | null;
      scopes: string;
      status: string;
      revoked_at: number | null;
    }>();
  if (!keyRow) return buildError(c, 'key_propagating', 'unknown key id');
  if (keyRow.status === 'revoked' || keyRow.revoked_at != null) {
    return buildError(c, 'key_revoked', 'key has been revoked');
  }
  if (!keyRow.principal_id) return buildError(c, 'forbidden', 'api key has no principal');
  const principal = await env.DB.prepare(
    `SELECT mailbox_id, disabled_at FROM principals WHERE id = ?`,
  )
    .bind(keyRow.principal_id)
    .first<{ mailbox_id: string; disabled_at: string | null }>();
  if (!principal || principal.disabled_at)
    return buildError(c, 'key_revoked', 'principal disabled');
  const plaintext = await env.KV_KEY_CACHE.get(`plain:${keyId}`);
  if (!plaintext) return buildError(c, 'key_propagating', 'key plaintext not yet propagated');
  const url = new URL(c.req.url);
  const r = await verify({
    direction: 'polaris-api.v1',
    method: c.req.method,
    path: url.pathname,
    query: url.search.slice(1),
    headers: { get: (n: string) => c.req.header(n) ?? null },
    body: bodyBytes,
    secret: plaintext,
    allowedAlgorithms: env.VERIFY_ALGORITHMS.split(','),
  });
  if (!r.ok) return buildError(c, 'bad_signature', 'hmac mismatch');
  let scopes: string[] = [];
  try {
    scopes = JSON.parse(keyRow.scopes);
  } catch {
    return buildError(c, 'forbidden', 'scopes parse failed');
  }
  return {
    kind: 'api_key',
    key_id: keyRow.id,
    mailbox_id: principal.mailbox_id,
    isBridge: scopes.includes('imap_bridge:read'),
  };
}

// ---------- POST /v1/mailboxes/:id/push-subscriptions ----------
pushSubscriptions.post('/v1/mailboxes/:id/push-subscriptions', async (c) => {
  const mailboxId = c.req.param('id');
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(mailboxId)) {
    return buildError(c, 'bad_request', 'invalid mailbox id');
  }
  const bodyBytes = new Uint8Array(await c.req.arrayBuffer());
  const auth = await authenticate(c, bodyBytes);
  if (auth instanceof Response) return auth;
  if (auth.mailbox_id && auth.mailbox_id !== mailboxId) {
    return buildError(c, 'not_found', 'mailbox not found');
  }
  let body: { device_id?: string; push_type?: string; expires_at?: string };
  try {
    body = JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    return buildError(c, 'bad_request', 'invalid JSON');
  }
  if (!body.device_id || typeof body.device_id !== 'string') {
    return buildError(c, 'bad_request', 'device_id required');
  }
  const pt = JmapPushType.safeParse(body.push_type);
  if (!pt.success) return buildError(c, 'bad_request', 'push_type must be websocket|eventsource');
  const id = ulid();
  const createdAt = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO jmap_push_subscriptions (id, mailbox_id, device_id, push_type, expires_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(id, mailboxId, body.device_id, pt.data, body.expires_at ?? null, createdAt)
    .run();
  // NOTE: audit_log.action CHECK constraint does not yet permit
  // `jmap_push_subscription.*` rows. Subscribers are tracked via the table
  // itself; no audit entry. TODO(production): widen the constraint in a
  // future migration if a compliance need arises.
  return c.json(
    {
      id,
      mailbox_id: mailboxId,
      device_id: body.device_id,
      push_type: pt.data,
      expires_at: body.expires_at ?? null,
      created_at: createdAt,
    },
    201,
  );
});

// ---------- GET /v1/mailboxes/:id/push-subscriptions ----------
pushSubscriptions.get('/v1/mailboxes/:id/push-subscriptions', async (c) => {
  const mailboxId = c.req.param('id');
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(mailboxId)) {
    return buildError(c, 'bad_request', 'invalid mailbox id');
  }
  const auth = await authenticate(c, new Uint8Array(0));
  if (auth instanceof Response) return auth;
  if (auth.mailbox_id && auth.mailbox_id !== mailboxId) {
    return buildError(c, 'not_found', 'mailbox not found');
  }
  const rows = await c.env.DB.prepare(
    `SELECT id, mailbox_id, device_id, push_type, expires_at, created_at
     FROM jmap_push_subscriptions WHERE mailbox_id = ?1
     ORDER BY created_at DESC`,
  )
    .bind(mailboxId)
    .all();
  return c.json({ data: rows.results });
});

// ---------- DELETE /v1/mailboxes/:id/push-subscriptions/:subId ----------
pushSubscriptions.delete('/v1/mailboxes/:id/push-subscriptions/:subId', async (c) => {
  const mailboxId = c.req.param('id');
  const subId = c.req.param('subId');
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(mailboxId) || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(subId)) {
    return buildError(c, 'bad_request', 'invalid id');
  }
  const auth = await authenticate(c, new Uint8Array(0));
  if (auth instanceof Response) return auth;
  if (auth.mailbox_id && auth.mailbox_id !== mailboxId) {
    return buildError(c, 'not_found', 'mailbox not found');
  }
  await c.env.DB.prepare(`DELETE FROM jmap_push_subscriptions WHERE id = ?1 AND mailbox_id = ?2`)
    .bind(subId, mailboxId)
    .run();
  return new Response(null, { status: 204 });
});
