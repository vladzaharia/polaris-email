// Unified /v1/messages REST surface.
//
// POST /v1/messages
//   - Content-Type: application/json     -> tenant API-key HMAC, SendRequest JSON
//   - Content-Type: message/rfc822       -> daemon HMAC, raw bytes
// GET  /v1/messages                       -> list + filters (messages:read)
// GET  /v1/messages/:id                   -> single message (messages:read)
// GET  /v1/messages/:id/attachments/:n    -> signed-URL download (HMAC + exp)
//
// Auth/HMAC and Content-Type dispatch live inline because the two auth flavors
// share a path. The shared `processMessage()` pipeline performs idempotency,
// R2 PUT, D1 INSERT, and enqueue.

import { Hono, type Context } from 'hono';
import { SendRequest } from '@polaris-email/schema';
import { verify } from '@polaris-email/hmac';
import { ulid } from '@polaris-email/ids';
import {
  composeFromJson,
  enforceSenderPolicy,
  mimeToMessage,
  parseStrict,
  MimeError,
  SenderPolicyError,
  summarizeMime,
  type UnifiedMessage,
  type MessageRowMeta,
} from '@polaris-email/mime';
import { mintAttachmentUrl, verifyAttachmentUrl } from '@polaris-email/cf-api';
import { revocationCheck } from '@polaris-email/revocation';
import type { Env } from '../env.js';
import { buildError } from '../errors.js';
import { audit } from '../audit.js';
import { processMessage, ProcessMessageError } from '../process-message.js';
import { rateLimit } from '../rate-limit.js';
import { autoMarkRead } from './messages-state.js';

export const messages = new Hono<{ Bindings: Env }>();

const DEFAULT_INLINE_BODY_BYTES = 65536;
const DEFAULT_INLINE_ATTACHMENTS_BYTES = 262144;
const DAEMON_DEFAULT_RATE_PER_MIN = 600;
// TODO(daemon-rate-limit): `daemons.rate_limit_per_min` column is not in
// 0001_init.sql; the daemon path falls back to this constant.
const ATTACHMENT_IP_RATE_PER_MIN = 100;

function inlineBodyMax(env: Env): number {
  const v = env.INLINE_BODY_BYTES_MAX
    ? Number(env.INLINE_BODY_BYTES_MAX)
    : DEFAULT_INLINE_BODY_BYTES;
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_INLINE_BODY_BYTES;
}
function inlineAttachmentsMax(env: Env): number {
  const v = env.INLINE_ATTACHMENTS_BYTES_MAX
    ? Number(env.INLINE_ATTACHMENTS_BYTES_MAX)
    : DEFAULT_INLINE_ATTACHMENTS_BYTES;
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_INLINE_ATTACHMENTS_BYTES;
}

interface AuthenticatedApiKey {
  key_id: string;
  mailbox_id: string;
  principal_id: string;
  sender_scope_ids: string[];
  scopes: string[];
  rate_limit_per_min: number;
}

type Ctx = Context<{ Bindings: Env }>;

async function authenticateApiKey(
  c: Ctx,
  bodyBytes: Uint8Array,
): Promise<AuthenticatedApiKey | Response> {
  const env = c.env;
  const keyId = c.req.header('x-polaris-key-id');
  if (!keyId) return buildError(c, 'unauthorized', 'X-Polaris-Key-Id required');
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(keyId))
    return buildError(c, 'unauthorized', 'X-Polaris-Key-Id format');

  const keyRow = await env.DB.prepare(
    `SELECT id, principal_id, scopes, rate_limit_per_min, status, revoked_at
       FROM api_keys WHERE id = ?`,
  )
    .bind(keyId)
    .first<{
      id: string;
      principal_id: string | null;
      scopes: string;
      rate_limit_per_min: number;
      status: 'primary' | 'secondary' | 'revoked';
      revoked_at: number | null;
    }>();
  if (!keyRow) {
    return buildError(c, 'key_propagating', 'unknown key id', { 'retry-after': '2' });
  }
  if (keyRow.status === 'revoked' || keyRow.revoked_at != null) {
    return buildError(c, 'key_revoked', 'key has been revoked');
  }
  if (!keyRow.principal_id) {
    return buildError(c, 'forbidden', 'api key has no principal');
  }
  const principal = await env.DB.prepare(
    `SELECT mailbox_id, disabled_at FROM principals WHERE id = ?`,
  )
    .bind(keyRow.principal_id)
    .first<{ mailbox_id: string; disabled_at: string | null }>();
  if (!principal || principal.disabled_at) {
    return buildError(c, 'key_revoked', 'principal disabled');
  }
  const scopeRows = await env.DB.prepare(
    `SELECT sender_id FROM api_key_sender_scopes WHERE api_key_id = ?`,
  )
    .bind(keyRow.id)
    .all<{ sender_id: string }>()
    .catch(() => ({ results: [] as { sender_id: string }[] }));
  const senderScopeIds = (scopeRows.results ?? []).map((r) => r.sender_id);

  const plaintext = await env.KV_KEY_CACHE.get(`plain:${keyId}`);
  if (!plaintext) {
    return buildError(c, 'key_propagating', 'key plaintext not yet propagated', {
      'retry-after': '2',
    });
  }

  const url = new URL(c.req.url);
  const result = await verify({
    direction: 'polaris-api',
    method: c.req.method,
    path: url.pathname,
    query: url.search.slice(1),
    headers: { get: (n: string) => c.req.header(n) ?? null },
    body: bodyBytes,
    secret: plaintext,
  });
  if (!result.ok) {
    if (result.code === 'clock_skew') return buildError(c, 'clock_skew', result.message);
    if (result.code === 'missing_header' || result.code === 'header_invalid')
      return buildError(c, 'bad_request', result.message);
    return buildError(c, 'bad_signature', 'hmac mismatch');
  }

  const nonceKey = `nonce:${keyId}:${result.nonce}`;
  const seen = await env.KV_NONCE.get(nonceKey);
  if (seen) return buildError(c, 'nonce_replay', 'nonce already used for this key');
  c.executionCtx.waitUntil(env.KV_NONCE.put(nonceKey, '1', { expirationTtl: 10 * 60 }));

  let parsedScopes: string[] = [];
  try {
    parsedScopes = JSON.parse(keyRow.scopes);
  } catch {
    return buildError(c, 'forbidden', 'scopes parse failed');
  }

  return {
    key_id: keyRow.id,
    mailbox_id: principal.mailbox_id,
    principal_id: keyRow.principal_id,
    sender_scope_ids: senderScopeIds,
    scopes: parsedScopes,
    rate_limit_per_min: keyRow.rate_limit_per_min,
  };
}

interface AuthenticatedDaemon {
  daemonId: string;
  submissionId: string;
}

async function authenticateDaemon(
  c: Ctx,
  bodyBytes: Uint8Array,
): Promise<AuthenticatedDaemon | Response> {
  const env = c.env;
  const daemonId = c.req.header('x-polaris-daemon-id');
  const submissionId = c.req.header('x-polaris-submission-id');
  if (!daemonId) return buildError(c, 'unauthorized', 'X-Polaris-Daemon-Id required');
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(daemonId)) {
    return buildError(c, 'unauthorized', 'invalid daemon_id format');
  }
  if (!submissionId || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(submissionId)) {
    return buildError(c, 'unauthorized', 'invalid submission_id format');
  }
  if (!env.DAEMON_HMAC_KEY) {
    return buildError(c, 'unauthorized', 'daemon auth not configured on server');
  }
  const url = new URL(c.req.url);
  const result = await verify({
    direction: 'polaris-api',
    method: c.req.method,
    path: url.pathname,
    query: url.search.slice(1),
    headers: { get: (n: string) => c.req.header(n) ?? null },
    body: bodyBytes,
    secret: env.DAEMON_HMAC_KEY,
  });
  if (!result.ok) {
    return buildError(c, 'unauthorized', `daemon HMAC: ${result.code}`);
  }
  return { daemonId, submissionId };
}

async function loadR2Bytes(env: Env, key: string): Promise<Uint8Array | null> {
  const obj = await env.R2.get(key);
  if (!obj) return null;
  const buf = await (obj as unknown as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer();
  return new Uint8Array(buf);
}

type MessageRow = {
  id: string;
  mailbox_id: string;
  principal_id: string | null;
  direction: 'in' | 'out';
  status: string;
  from_addr: string;
  to_addrs: string | null;
  subject: string | null;
  r2_key: string;
  body_bytes: number | null;
  attachments_total_bytes: number | null;
  thread_id: string | null;
  header_message_id: string | null;
  auth_spf: string | null;
  auth_dkim: string | null;
  auth_dmarc: string | null;
  auth_remote_ip: string | null;
  received_at_daemon: string | null;
  received_at_api: string | null;
  queued_at: string | null;
  sending_at: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
  bounce_metadata: string | null;
  last_error: string | null;
  created_at: string;
};

function rowMeta(row: MessageRow): MessageRowMeta {
  return {
    id: row.id,
    mailbox_id: row.mailbox_id,
    direction: row.direction,
    status: row.status,
    thread_id: row.thread_id,
    header_message_id: row.header_message_id,
    auth_spf: row.auth_spf,
    auth_dkim: row.auth_dkim,
    auth_dmarc: row.auth_dmarc,
    auth_remote_ip: row.auth_remote_ip,
    body_bytes: row.body_bytes,
    attachments_total_bytes: row.attachments_total_bytes,
    received_at_daemon: row.received_at_daemon,
    received_at_api: row.received_at_api,
    queued_at: row.queued_at,
    sending_at: row.sending_at,
    sent_at: row.sent_at,
    delivered_at: row.delivered_at,
    failed_at: row.failed_at,
    bounce_metadata: row.bounce_metadata,
    last_error: row.last_error,
    created_at: row.created_at,
  };
}

async function renderMessageBodies(
  env: Env,
  msg: UnifiedMessage,
  raw: Uint8Array,
  options: { listMode: boolean },
): Promise<UnifiedMessage> {
  const inlineBody = inlineBodyMax(env);
  const inlineAtt = inlineAttachmentsMax(env);
  const bodyTotal = msg.body_bytes ?? raw.byteLength;
  const attTotal = msg.attachments_total_bytes ?? 0;

  if (options.listMode && (bodyTotal > inlineBody || attTotal > inlineAtt)) {
    const stripped: UnifiedMessage = { ...msg };
    delete stripped.text;
    delete stripped.html;
    stripped.attachments = msg.attachments.map((a) => ({ ...a }));
    return stripped;
  }
  const attachments = await Promise.all(
    msg.attachments.map(async (a, i) => {
      if (a.size_bytes <= inlineAtt) return { ...a };
      const url = await mintAttachmentUrl(env, msg.id, i);
      return { ...a, content_url: url };
    }),
  );
  const out: UnifiedMessage = { ...msg, attachments };
  if (bodyTotal > inlineBody) {
    delete out.text;
    delete out.html;
  }
  return out;
}

// ---------- POST /v1/messages ----------

messages.post('/v1/messages', async (c) => {
  const env = c.env;
  const contentType =
    (c.req.header('content-type') ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
  const hasKeyId = !!c.req.header('x-polaris-key-id');
  const hasDaemonId = !!c.req.header('x-polaris-daemon-id');

  const ab = await c.req.arrayBuffer();
  const bodyBytes = new Uint8Array(ab);

  if (contentType === 'application/json') {
    if (hasDaemonId && !hasKeyId) {
      return buildError(c, 'bad_content_type', 'daemon auth requires Content-Type: message/rfc822');
    }
    const authResult = await authenticateApiKey(c, bodyBytes);
    if (authResult instanceof Response) return authResult;
    const apiKey = authResult;

    if (!apiKey.scopes.includes('send')) {
      return buildError(c, 'scope_violation', 'missing scope send');
    }

    const rl = await rateLimit(env, apiKey.key_id, apiKey.rate_limit_per_min);
    if (!rl.ok) {
      await audit(env, {
        actor: apiKey.principal_id,
        action: 'rate_limit.exceeded',
        target: apiKey.key_id,
        meta: {
          endpoint: 'POST /v1/messages',
          limit_per_min: apiKey.rate_limit_per_min,
        },
      }).catch(() => undefined);
      return buildError(c, 'too_many_requests', 'rate limit exceeded', {
        'retry-after': String(rl.retryAfterSec),
      });
    }

    if (await revocationCheck(env, apiKey.principal_id)) {
      return buildError(c, 'key_revoked', 'principal revoked');
    }

    let req: SendRequest;
    try {
      req = SendRequest.parse(JSON.parse(new TextDecoder().decode(bodyBytes)));
    } catch (e) {
      return buildError(c, 'bad_request', e instanceof Error ? e.message : 'invalid JSON body');
    }

    if (apiKey.sender_scope_ids.length > 0) {
      const fromLc = req.from.toLowerCase();
      const matches = await env.DB.prepare(
        `SELECT id, address FROM mailbox_senders WHERE mailbox_id = ?`,
      )
        .bind(apiKey.mailbox_id)
        .all<{ id: string; address: string }>()
        .catch(() => ({ results: [] as { id: string; address: string }[] }));
      let ok = false;
      for (const s of matches.results) {
        if (apiKey.sender_scope_ids.includes(s.id) && s.address.toLowerCase() === fromLc) {
          ok = true;
          break;
        }
      }
      if (!ok) {
        return buildError(c, 'scope_violation', 'from address not in sender_scopes');
      }
    }

    const rawMime = composeFromJson(req);
    try {
      parseStrict(rawMime);
    } catch (e) {
      if (e instanceof MimeError) return buildError(c, 'bad_request', `MIME: ${e.code}`);
      throw e;
    }

    const idempotencyKey =
      c.req.header('idempotency-key') ?? req.idempotency_key ?? `rest-${ulid()}`;

    try {
      const envelopeTo = [...req.to, ...(req.cc ?? []), ...(req.bcc ?? [])];
      const result = await processMessage(env, {
        direction: 'out',
        source: 'rest',
        mailboxId: apiKey.mailbox_id,
        principalId: apiKey.principal_id,
        rawMime,
        idempotencyKey,
        envelopeTo,
      });
      return c.json(
        { message_id: result.messageId, status: result.status, fresh: result.fresh },
        202,
      );
    } catch (e) {
      if (e instanceof ProcessMessageError) {
        return c.json({ error: e.code, message: e.message }, e.httpStatus as 400 | 425 | 500);
      }
      throw e;
    }
  }

  if (contentType === 'message/rfc822') {
    if (hasKeyId && !hasDaemonId) {
      return buildError(
        c,
        'bad_content_type',
        'tenant API-key auth requires Content-Type: application/json',
      );
    }
    const authResult = await authenticateDaemon(c, bodyBytes);
    if (authResult instanceof Response) return authResult;
    const { daemonId, submissionId } = authResult;

    const rl = await rateLimit(env, `daemon:${daemonId}`, DAEMON_DEFAULT_RATE_PER_MIN);
    if (!rl.ok) {
      return buildError(c, 'too_many_requests', 'rate limit exceeded', {
        'retry-after': String(rl.retryAfterSec),
      });
    }

    let mime;
    try {
      mime = parseStrict(bodyBytes);
    } catch (e) {
      if (e instanceof MimeError) return buildError(c, 'bad_request', `MIME: ${e.code}`);
      throw e;
    }

    const username = c.req.header('x-polaris-smtp-username');
    if (!username) {
      return buildError(c, 'bad_request', 'X-Polaris-SMTP-Username header required');
    }
    const credRow = await env.DB.prepare(
      `SELECT principal_id, sender_id FROM submission_credentials
        WHERE username = ?1 AND disabled_at IS NULL LIMIT 1`,
    )
      .bind(username)
      .first<{ principal_id: string; sender_id: string }>();
    if (!credRow) return buildError(c, 'unauthorized', 'unknown principal for SMTP username');
    const principalRow = await env.DB.prepare(
      `SELECT id, mailbox_id, disabled_at FROM principals WHERE id = ?1 LIMIT 1`,
    )
      .bind(credRow.principal_id)
      .first<{ id: string; mailbox_id: string; disabled_at: string | null }>();
    if (!principalRow || principalRow.disabled_at) {
      return buildError(c, 'unauthorized', 'unknown principal for SMTP username');
    }
    if (await revocationCheck(env, principalRow.id)) {
      return buildError(c, 'key_revoked', 'principal revoked');
    }

    const senderRow = await env.DB.prepare(
      `SELECT address FROM mailbox_senders WHERE id = ?1 AND disabled_at IS NULL LIMIT 1`,
    )
      .bind(credRow.sender_id)
      .first<{ address: string }>()
      .catch(() => null);
    const allowedSenders: string[] = senderRow?.address ? [senderRow.address] : [];
    try {
      enforceSenderPolicy(mime, { allowedSenders });
    } catch (e) {
      if (e instanceof SenderPolicyError) {
        return buildError(c, 'forbidden', `sender policy: ${e.code}`);
      }
      throw e;
    }

    const idempotencyKey = c.req.header('idempotency-key') ?? `smtp-${submissionId}`;

    try {
      const result = await processMessage(env, {
        direction: 'out',
        source: 'smtp',
        mailboxId: principalRow.mailbox_id,
        principalId: principalRow.id,
        daemonId,
        rawMime: bodyBytes,
        idempotencyKey,
      });
      return c.json(
        { message_id: result.messageId, status: result.status, fresh: result.fresh },
        202,
      );
    } catch (e) {
      if (e instanceof ProcessMessageError) {
        return c.json({ error: e.code, message: e.message }, e.httpStatus as 400 | 425 | 500);
      }
      throw e;
    }
  }

  return buildError(
    c,
    'bad_content_type',
    'Content-Type must be application/json or message/rfc822',
  );
});

async function authenticateRead(c: Ctx): Promise<AuthenticatedApiKey | Response> {
  return authenticateApiKey(c, new Uint8Array(0));
}

function ensureReadScope(
  apiKey: AuthenticatedApiKey,
  options: { allowAdmin: boolean },
): true | string {
  if (apiKey.scopes.includes('messages:read')) return true;
  if (options.allowAdmin && apiKey.scopes.includes('admin:read')) return true;
  return 'missing scope messages:read';
}

// ---------- GET /v1/messages/:id ----------

messages.get('/v1/messages/:id', async (c) => {
  const id = c.req.param('id');
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) {
    return buildError(c, 'bad_request', 'invalid message id');
  }
  const auth = await authenticateRead(c);
  if (auth instanceof Response) return auth;
  const apiKey = auth;
  const scopeErr = ensureReadScope(apiKey, { allowAdmin: true });
  if (scopeErr !== true) return buildError(c, 'scope_violation', scopeErr);

  const rl = await rateLimit(c.env, `read:${apiKey.key_id}`, apiKey.rate_limit_per_min * 10);
  if (!rl.ok) {
    return buildError(c, 'too_many_requests', 'rate limit exceeded', {
      'retry-after': String(rl.retryAfterSec),
    });
  }

  const row = await c.env.DB.prepare(`SELECT * FROM messages WHERE id = ?1 LIMIT 1`)
    .bind(id)
    .first<MessageRow>();
  if (!row) return buildError(c, 'not_found', 'message not found');
  if (row.mailbox_id !== apiKey.mailbox_id && !apiKey.scopes.includes('admin:read')) {
    return buildError(c, 'not_found', 'message not found');
  }

  const raw = await loadR2Bytes(c.env, row.r2_key);
  if (!raw) return buildError(c, 'degraded', 'message body missing from R2');
  const msg = mimeToMessage(raw, rowMeta(row));
  const rendered = await renderMessageBodies(c.env, msg, raw, { listMode: false });
  if (apiKey.scopes.includes('imap_bridge:read')) {
    await autoMarkRead(c.env, row.mailbox_id, row.id);
  }
  return c.json(rendered);
});

// ---------- GET /v1/messages ----------

messages.get('/v1/messages', async (c) => {
  const auth = await authenticateRead(c);
  if (auth instanceof Response) return auth;
  const apiKey = auth;
  const scopeErr = ensureReadScope(apiKey, { allowAdmin: true });
  if (scopeErr !== true) return buildError(c, 'scope_violation', scopeErr);

  const rl = await rateLimit(c.env, `read:${apiKey.key_id}`, apiKey.rate_limit_per_min * 10);
  if (!rl.ok) {
    return buildError(c, 'too_many_requests', 'rate limit exceeded', {
      'retry-after': String(rl.retryAfterSec),
    });
  }

  const url = new URL(c.req.url);
  const params = url.searchParams;
  const isAdmin = apiKey.scopes.includes('admin:read');
  const mailboxIdParam = params.get('mailbox_id');
  const mailboxId = mailboxIdParam ?? (isAdmin ? null : apiKey.mailbox_id);
  if (!isAdmin && mailboxIdParam && mailboxIdParam !== apiKey.mailbox_id) {
    return buildError(c, 'scope_violation', 'cross-mailbox query requires admin:read');
  }
  const direction = params.get('direction');
  const status = params.get('status');
  const fromAddr = params.get('from');
  const toAddr = params.get('to');
  const since = params.get('since');
  const until = params.get('until');
  const q = params.get('q');
  const limitRaw = Number(params.get('limit') ?? '50');
  const limit = Math.min(200, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 50));
  const offsetRaw = Number(params.get('offset') ?? '0');
  const offset = Math.max(0, Number.isFinite(offsetRaw) ? offsetRaw : 0);

  const where: string[] = [];
  const binds: unknown[] = [];
  if (mailboxId) {
    where.push(`mailbox_id = ?`);
    binds.push(mailboxId);
  }
  if (direction === 'in' || direction === 'out') {
    where.push(`direction = ?`);
    binds.push(direction);
  }
  if (status) {
    where.push(`status = ?`);
    binds.push(status);
  }
  if (fromAddr) {
    where.push(`from_addr_normalized = ?`);
    binds.push(fromAddr.toLowerCase());
  }
  if (toAddr) {
    where.push(`to_addrs LIKE ?`);
    binds.push(`%${toAddr.toLowerCase()}%`);
  }
  if (since) {
    where.push(`created_at >= ?`);
    binds.push(since);
  }
  if (until) {
    where.push(`created_at <= ?`);
    binds.push(until);
  }
  if (q) {
    where.push(`(subject LIKE ? OR from_addr LIKE ?)`);
    binds.push(`%${q}%`, `%${q}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  // limit/offset are integer-validated above; inline them to keep the SQL
  // shape stable for downstream tooling and the in-memory mock D1 used in
  // tests.
  const sql = `SELECT * FROM messages ${whereSql} ORDER BY created_at DESC LIMIT ${limit + 1} OFFSET ${offset}`;
  const res = await c.env.DB.prepare(sql)
    .bind(...binds)
    .all<MessageRow>()
    .catch(() => ({ results: [] as MessageRow[] }));
  const rows = res.results.slice(0, limit);
  const hasMore = res.results.length > limit;

  const data: UnifiedMessage[] = [];
  for (const row of rows) {
    const raw = await loadR2Bytes(c.env, row.r2_key);
    if (!raw) continue;
    const msg = mimeToMessage(raw, rowMeta(row));
    const rendered = await renderMessageBodies(c.env, msg, raw, { listMode: true });
    data.push(rendered);
  }
  return c.json({ data, next_offset: hasMore ? offset + limit : null });
});

// ---------- GET /v1/messages/:id/attachments/:n ----------

messages.get('/v1/messages/:id/attachments/:n', async (c) => {
  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown';
  const rl = await rateLimit(c.env, `att:${ip}`, ATTACHMENT_IP_RATE_PER_MIN);
  if (!rl.ok) {
    return buildError(c, 'too_many_requests', 'rate limit exceeded', {
      'retry-after': String(rl.retryAfterSec),
    });
  }

  const url = new URL(c.req.url);
  const verifyRes = await verifyAttachmentUrl(c.env, url.toString());
  if (!verifyRes.ok) {
    return buildError(c, 'unauthorized', `signed url: ${verifyRes.reason}`);
  }
  const { messageId, attachmentIndex } = verifyRes.ref;
  const row = await c.env.DB.prepare(`SELECT r2_key FROM messages WHERE id = ?1 LIMIT 1`)
    .bind(messageId)
    .first<{ r2_key: string }>();
  if (!row) return buildError(c, 'not_found', 'message not found');
  const raw = await loadR2Bytes(c.env, row.r2_key);
  if (!raw) return buildError(c, 'not_found', 'message body missing');
  const summary = summarizeMime(raw);
  const att = summary.attachments[attachmentIndex];
  if (!att) return buildError(c, 'not_found', 'attachment index out of range');
  const part = extractAttachmentBytes(raw, attachmentIndex);
  if (!part) return buildError(c, 'not_found', 'attachment payload not located');
  return new Response(part.bytes, {
    status: 200,
    headers: {
      'content-type': att.content_type || 'application/octet-stream',
      'content-disposition': `attachment; filename="${att.filename.replace(/"/g, '')}"`,
      'cache-control': 'private, no-store',
    },
  });
});

function extractAttachmentBytes(raw: Uint8Array, index: number): { bytes: Uint8Array } | null {
  const text = new TextDecoder('latin1').decode(raw);
  const sep = text.indexOf('\r\n\r\n');
  const split = sep >= 0 ? sep : text.indexOf('\n\n');
  if (split < 0) return null;
  const headerStr = text.slice(0, split);
  const body = text.slice(split + (sep >= 0 ? 4 : 2));
  const ctMatch = /\bcontent-type:\s*([^\r\n]+)/i.exec(headerStr);
  if (!ctMatch) return null;
  const ct = ctMatch[1]!;
  const boundaryM = /boundary=("([^"]+)"|([^;\s]+))/i.exec(ct);
  if (!boundaryM) return null;
  const boundary = boundaryM[2] ?? boundaryM[3] ?? '';
  const found: Uint8Array[] = [];
  walkAttachmentParts(body, boundary, found);
  const hit = found[index];
  return hit ? { bytes: hit } : null;
}

function walkAttachmentParts(body: string, boundary: string, out: Uint8Array[]): void {
  const delim = '--' + boundary;
  let i = body.indexOf(delim);
  while (i >= 0) {
    const next = body.indexOf(delim, i + delim.length);
    if (next < 0) break;
    const chunk = body
      .slice(i + delim.length, next)
      .replace(/^\r?\n/, '')
      .replace(/\r?\n$/, '');
    const cutter = chunk.indexOf('\r\n\r\n');
    const hsplit = cutter >= 0 ? cutter : chunk.indexOf('\n\n');
    if (hsplit >= 0) {
      const hStr = chunk.slice(0, hsplit);
      const pBody = chunk.slice(hsplit + (cutter >= 0 ? 4 : 2));
      const subCt = /\bcontent-type:\s*([^\r\n]+)/i.exec(hStr)?.[1] ?? 'text/plain';
      const subDisp = /\bcontent-disposition:\s*([^\r\n]+)/i.exec(hStr)?.[1] ?? '';
      const subXfer = (/\bcontent-transfer-encoding:\s*([^\r\n]+)/i.exec(hStr)?.[1] ?? '')
        .toLowerCase()
        .trim();
      const inner = subCt.split(';')[0]?.toLowerCase().trim() ?? '';
      const innerBoundary = /boundary=("([^"]+)"|([^;\s]+))/i.exec(subCt);
      if (inner.startsWith('multipart/') && innerBoundary) {
        walkAttachmentParts(pBody, innerBoundary[2] ?? innerBoundary[3] ?? '', out);
      } else {
        const isAttachment =
          /attachment/i.test(subDisp) || /^application\/|^image\/|^video\/|^audio\//.test(inner);
        if (isAttachment) {
          out.push(decodeAttachment(pBody, subXfer));
        }
      }
    }
    i = next;
  }
}

function decodeAttachment(body: string, xfer: string): Uint8Array {
  if (xfer === 'base64') {
    try {
      const cleaned = body.replace(/\s+/g, '');
      const bin = atob(cleaned);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch {
      // fall through to latin1 passthrough
    }
  }
  const out = new Uint8Array(body.length);
  for (let i = 0; i < body.length; i++) out[i] = body.charCodeAt(i) & 0xff;
  return out;
}
