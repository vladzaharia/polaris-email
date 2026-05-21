// Bridge-facing message state endpoints (Phase L slice L.2).
//
// These complement `routes/messages.ts`:
//   * PATCH  /v1/messages/:id                            — set/clear flags
//   * DELETE /v1/messages/:id                            — soft-expunge
//   * POST   /v1/messages/get                            — bulk fetch by id
//   * POST   /v1/mailboxes/:id/expunge                   — hard-purge expunged
//   * GET    /v1/mailboxes/:id/changes?since_state=N     — changes delta
//   * GET    /v1/mailboxes/:id/messages?fields=metadata  — bridge initial sync
//
// Auth: either tenant api_key HMAC (with `messages:read` / `imap_bridge:read`)
// or bridge HMAC (`polaris-api`, bridge scoped to `imap_bridge:read`).
// Per L3.0, none of these mutators fire webhooks — only `change_id` is bumped
// so the IMAP CONDSTORE / IDLE transport notices.

import { Hono, type Context } from 'hono';
import { MessageFlag, type Message } from '@polaris-mail/schema';
import { verify, sha256Hex } from '@polaris-mail/hmac';
import { extractAttachmentParts, mimeToMessage, type UnifiedMessage } from '@polaris-mail/mime';
import type { Env } from '../env.js';
import { buildError } from '../errors.js';
import { audit } from '../audit.js';
import { allocChangeId, ensureMailboxState, purgeMessageRow } from '../lib/state.js';
import { r2PublicUrl, attachmentR2Key } from '../lib/r2-public-url.js';
import { lookupBridgeSecret } from '../bridge-auth.js';
import { revocationCheck } from '@polaris-mail/revocation';
import { NONCE_TTL_SECONDS } from '../auth.js';
import { MessageRow, rowMeta } from '../lib/message-row.js';
import { loadR2Bytes } from '../lib/r2-helpers.js';

export const messagesState = new Hono<{ Bindings: Env }>();

const DEFAULT_INLINE_BODY_BYTES = 65536;

function inlineBodyMax(env: Env): number {
  const v = env.INLINE_BODY_BYTES_MAX
    ? Number(env.INLINE_BODY_BYTES_MAX)
    : DEFAULT_INLINE_BODY_BYTES;
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_INLINE_BODY_BYTES;
}

interface AuthenticatedCaller {
  kind: 'api_key' | 'bridge';
  key_id: string;
  mailbox_id: string | null;
  principal_id: string | null;
  scopes: string[];
  isBridge: boolean;
}

type Ctx = Context<{ Bindings: Env }>;

async function authenticateCaller(
  c: Ctx,
  bodyBytes: Uint8Array,
): Promise<AuthenticatedCaller | Response> {
  const env = c.env;
  const keyId = c.req.header('x-polaris-key-id');
  const bridgeId = c.req.header('x-polaris-bridge-id');

  if (bridgeId && !keyId) {
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(bridgeId)) {
      return buildError(c, 'unauthorized', 'invalid bridge_id format');
    }
    const lookup = await lookupBridgeSecret(env, bridgeId);
    if (!lookup.ok) {
      if (lookup.code === 'key_propagating') {
        return buildError(
          c,
          'key_propagating',
          'bridge plaintext not in cache; rotate to repopulate',
          { 'retry-after': '2' },
        );
      }
      return buildError(c, 'unauthorized', `bridge: ${lookup.code}`);
    }
    const url = new URL(c.req.url);
    const result = await verify({
      direction: 'polaris-api',
      method: c.req.method,
      path: url.pathname,
      query: url.search.slice(1),
      headers: { get: (n: string) => c.req.header(n) ?? null },
      body: bodyBytes,
      secret: lookup.secret,
    });
    if (!result.ok) return buildError(c, 'unauthorized', `bridge HMAC: ${result.code}`);
    return {
      kind: 'bridge',
      key_id: bridgeId,
      mailbox_id: null,
      principal_id: null,
      scopes: ['imap_bridge:read', 'messages:read'],
      isBridge: true,
    };
  }

  if (!keyId)
    return buildError(c, 'unauthorized', 'X-Polaris-Key-Id or X-Polaris-Bridge-Id required');
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(keyId)) {
    return buildError(c, 'unauthorized', 'X-Polaris-Key-Id format');
  }
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
  if (!keyRow) return buildError(c, 'key_propagating', 'unknown key id', { 'retry-after': '2' });
  if (keyRow.status === 'revoked' || keyRow.revoked_at != null) {
    return buildError(c, 'key_revoked', 'key has been revoked');
  }
  if (!keyRow.principal_id) return buildError(c, 'forbidden', 'api key has no principal');
  const principal = await env.DB.prepare(
    `SELECT mailbox_id, disabled_at FROM principals WHERE id = ?`,
  )
    .bind(keyRow.principal_id)
    .first<{ mailbox_id: string; disabled_at: string | null }>();
  if (!principal || principal.disabled_at) {
    return buildError(c, 'key_revoked', 'principal disabled');
  }
  // Per-principal revocation check BEFORE HMAC verify. Phase 3b.1 — see
  // the matching block in `auth.ts` and `routes/messages.ts` for rationale.
  // KV_REVOCATIONS is the authoritative signal; KV_KEY_CACHE may still
  // surface a stale `primary` row for a few seconds after revoke.
  if (await revocationCheck(env, keyRow.principal_id).catch(() => false)) {
    return buildError(c, 'key_revoked', 'principal revoked');
  }
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
  c.executionCtx.waitUntil(env.KV_NONCE.put(nonceKey, '1', { expirationTtl: NONCE_TTL_SECONDS }));

  let parsedScopes: string[] = [];
  try {
    parsedScopes = JSON.parse(keyRow.scopes);
  } catch {
    return buildError(c, 'forbidden', 'scopes parse failed');
  }
  return {
    kind: 'api_key',
    key_id: keyRow.id,
    mailbox_id: principal.mailbox_id,
    principal_id: keyRow.principal_id,
    scopes: parsedScopes,
    isBridge: parsedScopes.includes('imap_bridge:read'),
  };
}

function hasReadScope(caller: AuthenticatedCaller): boolean {
  return (
    caller.scopes.includes('messages:read') ||
    caller.scopes.includes('imap_bridge:read') ||
    caller.scopes.includes('admin:read')
  );
}

function hasMutateScope(caller: AuthenticatedCaller): boolean {
  return caller.scopes.includes('messages:read') || caller.scopes.includes('imap_bridge:read');
}

async function renderMessage(
  env: Env,
  raw: Uint8Array,
  row: MessageRow,
  opts: { stripBodies: boolean },
): Promise<UnifiedMessage> {
  const msg = mimeToMessage(raw, rowMeta(row));
  const bodyUrl = r2PublicUrl(env, row.r2_key);
  if (opts.stripBodies) {
    const stripped: UnifiedMessage = { ...msg, body_url: bodyUrl };
    delete stripped.text;
    delete stripped.html;
    stripped.attachments = (msg.attachments ?? []).map((a) => {
      const copy = { ...a };
      delete (copy as { content_base64?: string }).content_base64;
      return copy;
    });
    // metadata-mode keeps `url` if it was set upstream; the bridge sync
    // path doesn't populate inline bytes anyway.
    return stripped;
  }
  const inlineBody = inlineBodyMax(env);
  const parts = extractAttachmentParts(raw);
  const attachments = await Promise.all(
    (msg.attachments ?? []).map(async (a, i) => {
      const copy: typeof a = { ...a };
      const part = parts[i];
      if (part) {
        const sha = await sha256Hex(part.bytes);
        copy.url = r2PublicUrl(env, attachmentR2Key(sha, part.filename), part.filename);
      }
      return copy;
    }),
  );
  const out: UnifiedMessage = { ...msg, body_url: bodyUrl, attachments };
  const bodyTotal = msg.body_bytes ?? raw.byteLength;
  if (bodyTotal > inlineBody) {
    delete out.text;
    delete out.html;
  }
  return out;
}

async function autoMarkRead(env: Env, mailboxId: string, messageId: string): Promise<void> {
  const state = await ensureMailboxState(env.DB, mailboxId, messageId);
  if (state.read_at) return;
  const now = new Date().toISOString();
  const flags = parseFlags(state.flags_json);
  if (!flags.includes('\\Seen')) flags.push('\\Seen');
  const change = await allocChangeId(env.DB, mailboxId);
  await env.DB.prepare(
    `UPDATE mailbox_messages_state SET read_at = ?1, flags_json = ?2, change_id = ?3
     WHERE mailbox_id = ?4 AND message_id = ?5`,
  )
    .bind(now, JSON.stringify(flags), change, mailboxId, messageId)
    .run();
}

function parseFlags(json: string): string[] {
  try {
    const v = JSON.parse(json);
    if (Array.isArray(v)) return v.filter((x) => typeof x === 'string');
  } catch {
    // fall through
  }
  return [];
}

async function loadMessage(env: Env, messageId: string): Promise<MessageRow | null> {
  return env.DB.prepare(`SELECT * FROM messages WHERE id = ?1 LIMIT 1`)
    .bind(messageId)
    .first<MessageRow>();
}

// ---------- PATCH /v1/messages/:id ----------
messagesState.patch('/v1/messages/:id', async (c) => {
  const id = c.req.param('id');
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id))
    return buildError(c, 'bad_request', 'invalid message id');

  const bodyBytes = new Uint8Array(await c.req.arrayBuffer());
  const auth = await authenticateCaller(c, bodyBytes);
  if (auth instanceof Response) return auth;
  if (!hasMutateScope(auth)) return buildError(c, 'scope_violation', 'missing scope messages:read');

  let body: { flags?: unknown };
  try {
    body =
      bodyBytes.byteLength > 0
        ? (JSON.parse(new TextDecoder().decode(bodyBytes)) as typeof body)
        : {};
  } catch {
    return buildError(c, 'bad_request', 'invalid JSON');
  }
  let flags: string[] | undefined;
  if (body.flags !== undefined) {
    if (!Array.isArray(body.flags)) return buildError(c, 'bad_request', 'flags must be array');
    flags = [];
    for (const f of body.flags) {
      const p = MessageFlag.safeParse(f);
      if (!p.success) return buildError(c, 'bad_request', `invalid flag: ${String(f)}`);
      flags.push(p.data);
    }
  }

  const row = await loadMessage(c.env, id);
  if (!row) return buildError(c, 'not_found', 'message not found');
  if (auth.mailbox_id && row.mailbox_id !== auth.mailbox_id) {
    return buildError(c, 'not_found', 'message not found');
  }

  const state = await ensureMailboxState(c.env.DB, row.mailbox_id, id);
  const oldFlags = parseFlags(state.flags_json);
  const newFlags = flags ?? oldFlags;
  const seenWasSet = oldFlags.includes('\\Seen');
  const seenNowSet = newFlags.includes('\\Seen');
  const now = new Date().toISOString();
  const readAt = !seenWasSet && seenNowSet ? now : state.read_at;
  const changeId = await allocChangeId(c.env.DB, row.mailbox_id);
  await c.env.DB.prepare(
    `UPDATE mailbox_messages_state
       SET flags_json = ?1, read_at = ?2, change_id = ?3
     WHERE mailbox_id = ?4 AND message_id = ?5`,
  )
    .bind(JSON.stringify(newFlags), readAt, changeId, row.mailbox_id, id)
    .run();

  if (!seenWasSet && seenNowSet) {
    await audit(c.env, {
      actor: auth.principal_id ?? auth.key_id,
      action: 'message.marked_read',
      target: id,
      meta: { mailbox_id: row.mailbox_id },
    });
  }

  const raw = await loadR2Bytes(c.env, row.r2_key);
  if (!raw) return buildError(c, 'degraded', 'message body missing from R2');
  const rendered = await renderMessage(c.env, raw, row, { stripBodies: false });
  return c.json({
    ...rendered,
    flags: newFlags,
    read_at: readAt,
    change_id: changeId,
  } as unknown as Message);
});

// ---------- DELETE /v1/messages/:id ----------
messagesState.delete('/v1/messages/:id', async (c) => {
  const id = c.req.param('id');
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id))
    return buildError(c, 'bad_request', 'invalid message id');

  const bodyBytes = new Uint8Array(0);
  const auth = await authenticateCaller(c, bodyBytes);
  if (auth instanceof Response) return auth;
  if (!hasMutateScope(auth)) return buildError(c, 'scope_violation', 'missing scope messages:read');

  const row = await loadMessage(c.env, id);
  if (!row) return buildError(c, 'not_found', 'message not found');
  if (auth.mailbox_id && row.mailbox_id !== auth.mailbox_id) {
    return buildError(c, 'not_found', 'message not found');
  }

  await ensureMailboxState(c.env.DB, row.mailbox_id, id);
  const now = new Date().toISOString();
  const changeId = await allocChangeId(c.env.DB, row.mailbox_id);
  await c.env.DB.prepare(
    `UPDATE mailbox_messages_state
       SET expunged_at = ?1, change_id = ?2
     WHERE mailbox_id = ?3 AND message_id = ?4`,
  )
    .bind(now, changeId, row.mailbox_id, id)
    .run();
  await audit(c.env, {
    actor: auth.principal_id ?? auth.key_id,
    action: 'message.expunged',
    target: id,
    meta: { mailbox_id: row.mailbox_id, soft: true },
  });
  return new Response(null, { status: 204 });
});

// ---------- POST /v1/mailboxes/:id/expunge ----------
messagesState.post('/v1/mailboxes/:id/expunge', async (c) => {
  const mailboxId = c.req.param('id');
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(mailboxId)) {
    return buildError(c, 'bad_request', 'invalid mailbox id');
  }
  const bodyBytes = new Uint8Array(await c.req.arrayBuffer());
  const auth = await authenticateCaller(c, bodyBytes);
  if (auth instanceof Response) return auth;
  if (!auth.scopes.includes('admin:rotate')) {
    return buildError(c, 'scope_violation', 'missing scope admin:rotate');
  }

  const states = await c.env.DB.prepare(
    `SELECT message_id FROM mailbox_messages_state
     WHERE mailbox_id = ?1 AND expunged_at IS NOT NULL`,
  )
    .bind(mailboxId)
    .all<{ message_id: string }>();
  let removed = 0;
  let r2Freed = 0;
  for (const s of states.results) {
    await c.env.DB.prepare(
      `DELETE FROM mailbox_messages_state WHERE mailbox_id = ?1 AND message_id = ?2`,
    )
      .bind(mailboxId, s.message_id)
      .run();
    removed += 1;
    // Check if the messages row is referenced by any other mailbox state row.
    const otherState = await c.env.DB.prepare(
      `SELECT 1 AS one FROM mailbox_messages_state WHERE message_id = ?1 LIMIT 1`,
    )
      .bind(s.message_id)
      .first<{ one: number }>()
      .catch(() => null);
    if (otherState) continue; // Another mailbox still references the message — keep it.
    const msgRow = await c.env.DB.prepare(`SELECT id, r2_key FROM messages WHERE id = ?1 LIMIT 1`)
      .bind(s.message_id)
      .first<{ id: string; r2_key: string }>();
    if (!msgRow) continue;
    const { r2_deleted } = await purgeMessageRow({ DB: c.env.DB, R2: c.env.R2 }, msgRow);
    if (r2_deleted) r2Freed += 1;
  }

  await audit(c.env, {
    actor: auth.principal_id ?? auth.key_id,
    action: 'mailbox.expunge',
    target: mailboxId,
    meta: { removed, r2_freed: r2Freed },
  });
  return c.json({ removed, r2_freed: r2Freed });
});

// ---------- POST /v1/messages/get ----------
messagesState.post('/v1/messages/get', async (c) => {
  const bodyBytes = new Uint8Array(await c.req.arrayBuffer());
  const auth = await authenticateCaller(c, bodyBytes);
  if (auth instanceof Response) return auth;
  if (!hasReadScope(auth)) return buildError(c, 'scope_violation', 'missing scope messages:read');

  let body: { ids?: unknown };
  try {
    body = JSON.parse(new TextDecoder().decode(bodyBytes)) as typeof body;
  } catch {
    return buildError(c, 'bad_request', 'invalid JSON');
  }
  if (!Array.isArray(body.ids)) return buildError(c, 'bad_request', 'ids must be array');
  const ids = body.ids.filter((x): x is string => typeof x === 'string').slice(0, 200);

  const data: UnifiedMessage[] = [];
  const notFound: string[] = [];
  for (const id of ids) {
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) {
      notFound.push(id);
      continue;
    }
    const row = await loadMessage(c.env, id);
    if (!row) {
      notFound.push(id);
      continue;
    }
    if (auth.mailbox_id && row.mailbox_id !== auth.mailbox_id) {
      notFound.push(id);
      continue;
    }
    const raw = await loadR2Bytes(c.env, row.r2_key);
    if (!raw) {
      notFound.push(id);
      continue;
    }
    const rendered = await renderMessage(c.env, raw, row, { stripBodies: false });
    data.push(rendered);
    if (auth.isBridge) {
      await autoMarkRead(c.env, row.mailbox_id, id);
    }
  }
  return c.json({ data, not_found: notFound });
});

// ---------- GET /v1/mailboxes/:id/changes ----------
messagesState.get('/v1/mailboxes/:id/changes', async (c) => {
  const mailboxId = c.req.param('id');
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(mailboxId)) {
    return buildError(c, 'bad_request', 'invalid mailbox id');
  }
  const auth = await authenticateCaller(c, new Uint8Array(0));
  if (auth instanceof Response) return auth;
  if (!hasReadScope(auth)) return buildError(c, 'scope_violation', 'missing scope messages:read');
  if (auth.mailbox_id && auth.mailbox_id !== mailboxId) {
    return buildError(c, 'not_found', 'mailbox not found');
  }

  const sinceRaw = c.req.query('since_state');
  const since = sinceRaw ? Number.parseInt(sinceRaw, 10) : 0;
  if (!Number.isFinite(since) || since < 0) {
    return buildError(c, 'bad_request', 'since_state must be non-negative integer');
  }
  const limitRaw = c.req.query('limit');
  const limit = Math.min(500, Math.max(1, Number.parseInt(limitRaw ?? '100', 10) || 100));

  const rows = await c.env.DB.prepare(
    `SELECT message_id, expunged_at, change_id FROM mailbox_messages_state
     WHERE mailbox_id = ?1 AND change_id > ?2
     ORDER BY change_id ASC LIMIT ${limit}`,
  )
    .bind(mailboxId, since)
    .all<{ message_id: string; expunged_at: string | null; change_id: number }>();

  const updated: string[] = [];
  const deleted: string[] = [];
  let maxChange = since;
  for (const r of rows.results) {
    if (r.change_id > maxChange) maxChange = r.change_id;
    if (r.expunged_at) deleted.push(r.message_id);
    else updated.push(r.message_id);
  }
  return c.json({
    added: [] as string[],
    updated,
    deleted,
    state: rows.results.length === 0 ? since : maxChange,
  });
});

// ---------- GET /v1/mailboxes/:id/messages (metadata-only) ----------
messagesState.get('/v1/mailboxes/:id/messages', async (c) => {
  const mailboxId = c.req.param('id');
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(mailboxId)) {
    return buildError(c, 'bad_request', 'invalid mailbox id');
  }
  const fields = c.req.query('fields');
  if (fields !== 'metadata') {
    return buildError(c, 'bad_request', 'fields=metadata required for bridge sync');
  }
  const auth = await authenticateCaller(c, new Uint8Array(0));
  if (auth instanceof Response) return auth;
  if (!hasReadScope(auth)) return buildError(c, 'scope_violation', 'missing scope messages:read');
  if (auth.mailbox_id && auth.mailbox_id !== mailboxId) {
    return buildError(c, 'not_found', 'mailbox not found');
  }
  const limit = Math.min(
    500,
    Math.max(1, Number.parseInt(c.req.query('limit') ?? '100', 10) || 100),
  );
  const offset = Math.max(0, Number.parseInt(c.req.query('offset') ?? '0', 10) || 0);
  const rows = await c.env.DB.prepare(
    `SELECT * FROM messages WHERE mailbox_id = ?1 ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
  )
    .bind(mailboxId)
    .all<MessageRow>();
  const data: UnifiedMessage[] = [];
  for (const row of rows.results) {
    const raw = await loadR2Bytes(c.env, row.r2_key);
    if (!raw) continue;
    const rendered = await renderMessage(c.env, raw, row, { stripBodies: true });
    data.push(rendered);
  }
  return c.json({ data });
});

/** Exported so the existing read handlers can opt into auto-mark-read. */
export { autoMarkRead };
