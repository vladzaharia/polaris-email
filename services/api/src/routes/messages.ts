// Unified /v1/messages REST surface.
//
// POST /v1/messages
//   - Content-Type: application/json     -> mailbox API-key HMAC, SendRequest JSON
//   - Content-Type: message/rfc822       -> bridge HMAC, raw bytes
// GET  /v1/messages                       -> list + filters (messages:read)
// GET  /v1/messages/:id                   -> single message (messages:read)
//
// Auth/HMAC and Content-Type dispatch live inline because the two auth flavors
// share a path. The shared `processMessage()` pipeline performs idempotency,
// R2 PUT, D1 INSERT, and enqueue.
//
// Attachment downloads are no longer minted as signed URLs. Bodies +
// attachments are published on the R2 custom domain `r2.mail.plrs.im`; the
// `url` on each attachment + the `body_url` on the message point directly
// there. The previous `GET /v1/messages/:id/attachments/:n` handler is
// deleted.

import { Hono, type Context } from 'hono';
import type { z } from 'zod';
import { SendRequest, type ErrorCode } from '@polaris-email/schema';
import { verify, sha256Hex } from '@polaris-email/hmac';
import {
  composeFromJson,
  enforceSenderPolicy,
  extractAttachmentParts,
  mimeToMessage,
  parseStrict,
  MAX_MESSAGE_SIZE_VERIFIED,
  MimeError,
  SenderPolicyError,
  type UnifiedMessage,
} from '@polaris-email/mime';
import { revocationCheck } from '@polaris-email/revocation';
import type { Env } from '../env.js';
import { buildError } from '../errors.js';
import { audit } from '../audit.js';
import { processMessage, ProcessMessageError } from '../process-message.js';
import { rateLimit } from '../rate-limit.js';
import { r2PublicUrl, attachmentR2Key } from '../lib/r2-public-url.js';
import { autoMarkRead } from './messages-state.js';
import { lookupBridgeSecret } from '../bridge-auth.js';
import { NONCE_TTL_SECONDS } from '../auth.js';
import { MessageRow, rowMeta } from '../lib/message-row.js';
import { loadR2Bytes } from '../lib/r2-helpers.js';

export const messages = new Hono<{ Bindings: Env }>();

const DEFAULT_INLINE_BODY_BYTES = 65536;
const DEFAULT_INLINE_ATTACHMENTS_BYTES = 262144;
// Per-bridge rate limit. The bridges table doesn't carry a per-row cap
// today, so every bridge gets this uniform allowance. A future migration
// could add `bridges.rate_limit_per_min` and the lookup here would
// switch to per-bridge rows.
const BRIDGE_DEFAULT_RATE_PER_MIN = 600;

// allowlist of typed ErrorCodes that the SendRequest superRefine
// is permitted to surface via its `"<code>:<detail>"` issue.message convention.
// Adding to this set is a deliberate act and must be paired with a matching
// entry in ERROR_HTTP / ERROR_RETRYABLE (see errors.ts). Anything outside this
// set falls back to bad_request so unknown free-form messages never leak as
// novel error codes to callers.
export const CF_TYPED_CODES = new Set<ErrorCode>([
  'too_many_recipients',
  'subject_too_long',
  'message_too_large',
  'header_not_allowed',
  'header_too_long',
  'too_many_custom_headers',
  'custom_headers_too_large',
]);

/**
 * Classify a zod issue into a typed ErrorCode + human-readable message.
 *
 * Contract: SendRequest.superRefine emits issues whose `message` is
 * shaped as `"<error_code>:<detail>"` (e.g., `"too_many_recipients:51 exceeds 50"`).
 * This function splits on the first colon and, if the prefix is in
 * `CF_TYPED_CODES`, returns the typed code with the detail portion as the
 * human message. Otherwise returns `bad_request` with the raw message verbatim.
 *
 * Exported for unit testing — keep the implementation here so the production
 * call site and the test exercise the same logic.
 */
export function classifyZodIssue(issue: z.ZodIssue): { code: ErrorCode; message: string } {
  const [maybeCode, ...rest] = issue.message.split(':');
  const detail = rest.join(':') || issue.message;
  if (CF_TYPED_CODES.has(maybeCode as ErrorCode)) {
    return { code: maybeCode as ErrorCode, message: detail };
  }
  return { code: 'bad_request', message: issue.message };
}

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

  // Per-principal revocation check BEFORE HMAC verify. Mirrors the order
  // used by the shared `hmacAuth` middleware in `auth.ts`: KV_REVOCATIONS
  // is the authoritative revocation signal because the api_keys row may
  // still read `primary` from a stale KV_KEY_CACHE entry immediately after
  // an admin revoke. Phase 3b.1 — previously this check ran AFTER HMAC
  // verification, which let a revoked-but-still-cached key burn through a
  // verify cycle.
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
    key_id: keyRow.id,
    mailbox_id: principal.mailbox_id,
    principal_id: keyRow.principal_id,
    sender_scope_ids: senderScopeIds,
    scopes: parsedScopes,
    rate_limit_per_min: keyRow.rate_limit_per_min,
  };
}

interface AuthenticatedBridge {
  bridgeId: string;
  submissionId: string;
}

async function authenticateBridge(
  c: Ctx,
  bodyBytes: Uint8Array,
): Promise<AuthenticatedBridge | Response> {
  const env = c.env;
  const bridgeId = c.req.header('x-polaris-bridge-id');
  const submissionId = c.req.header('x-polaris-submission-id');
  if (!bridgeId) return buildError(c, 'unauthorized', 'X-Polaris-Bridge-Id required');
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(bridgeId)) {
    return buildError(c, 'unauthorized', 'invalid bridge_id format');
  }
  if (!submissionId || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(submissionId)) {
    return buildError(c, 'unauthorized', 'invalid submission_id format');
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
  if (!result.ok) {
    return buildError(c, 'unauthorized', `bridge HMAC: ${result.code}`);
  }
  return { bridgeId, submissionId };
}

async function renderMessageBodies(
  env: Env,
  msg: UnifiedMessage,
  raw: Uint8Array,
  bodyR2Key: string,
  options: { listMode: boolean },
): Promise<UnifiedMessage> {
  const inlineBody = inlineBodyMax(env);
  const inlineAtt = inlineAttachmentsMax(env);
  const bodyTotal = msg.body_bytes ?? raw.byteLength;
  const attTotal = msg.attachments_total_bytes ?? 0;

  // body_url is always set: per B5 the body is publicly addressable on
  // `r2.mail.plrs.im`, content-addressed, capability-token style.
  const bodyUrl = r2PublicUrl(env, bodyR2Key);

  if (options.listMode && (bodyTotal > inlineBody || attTotal > inlineAtt)) {
    const stripped: UnifiedMessage = { ...msg, body_url: bodyUrl };
    delete stripped.text;
    delete stripped.html;
    stripped.attachments = msg.attachments.map((a) => ({ ...a }));
    return stripped;
  }

  // Re-extract per-attachment bytes so we can compute the content-addressed
  // SHA-256 and stamp a public URL. The pipeline also wrote each
  // attachment to R2 under the same `att/<sha256>/<filename>` key on
  // ingest, so the URL is durable.
  const parts = extractAttachmentParts(raw);
  const attachments = await Promise.all(
    msg.attachments.map(async (a, i) => {
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
  const hasBridgeId = !!c.req.header('x-polaris-bridge-id');

  const ab = await c.req.arrayBuffer();
  const bodyBytes = new Uint8Array(ab);

  if (contentType === 'application/json') {
    if (hasBridgeId && !hasKeyId) {
      return buildError(c, 'bad_content_type', 'bridge auth requires Content-Type: message/rfc822');
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

    // parse + validate in two steps so we can distinguish JSON
    // syntax errors (always `bad_request`) from zod validation issues that may
    // map to typed CF error codes via the `"<code>:<detail>"` convention.
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch {
      return buildError(c, 'bad_request', 'invalid JSON body');
    }
    const parseResult = SendRequest.safeParse(parsedBody);
    if (!parseResult.success) {
      // Zod guarantees at least one issue when success=false; the optional
      // chain is a strict-mode appeasement (noUncheckedIndexedAccess).
      const firstIssue = parseResult.error.issues[0];
      if (!firstIssue) return buildError(c, 'bad_request', 'invalid request body');
      const { code, message } = classifyZodIssue(firstIssue);
      return buildError(c, code, message);
    }
    const req: SendRequest = parseResult.data;

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

    // W9 — Auto-synthesize In-Reply-To + References from the parent message
    // when the caller provided in_reply_to_message_id (preferred) or thread_id.
    // We never overwrite headers the caller set explicitly; this only fills
    // gaps. The References chain is the parent's References (if present) plus
    // the parent's Message-ID — capped at the last 10 entries per RFC 5322
    // guidance to keep header size bounded.
    const reqWithThreading = await synthesizeReplyHeaders(env, req);
    const rawMime = composeFromJson(reqWithThreading);
    // reject before parseStrict (and before enqueue) so callers see
    // a typed `message_too_large` (HTTP 413) rather than a generic MIME error.
    // The 25 MiB cap is the CF Email Service verified-domain ceiling; it is a
    // separate contract from the canonicalizer's 64 KiB header cap, so the
    // check lives here at the route boundary, not inside parseStrict.
    if (rawMime.byteLength > MAX_MESSAGE_SIZE_VERIFIED) {
      return buildError(
        c,
        'message_too_large',
        `message ${rawMime.byteLength} bytes exceeds ${MAX_MESSAGE_SIZE_VERIFIED}`,
      );
    }
    try {
      parseStrict(rawMime);
    } catch (e) {
      if (e instanceof MimeError) return buildError(c, 'bad_request', `MIME: ${e.code}`);
      throw e;
    }

    // REST callers MUST supply an idempotency key (header or body field).
    // Silently synthesizing one would make retries deliver duplicates, since
    // a fresh ULID never matches a prior attempt. Reject with a clear error
    // pointing to the missing field.
    const idempotencyKey = c.req.header('idempotency-key') ?? req.idempotency_key;
    if (!idempotencyKey) {
      return buildError(
        c,
        'bad_request',
        'idempotency key required: send `Idempotency-Key` header or `idempotency_key` body field',
      );
    }

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
    if (hasKeyId && !hasBridgeId) {
      return buildError(
        c,
        'bad_content_type',
        'mailbox API-key auth requires Content-Type: application/json',
      );
    }
    const authResult = await authenticateBridge(c, bodyBytes);
    if (authResult instanceof Response) return authResult;
    const { bridgeId, submissionId } = authResult;

    const rl = await rateLimit(env, `bridge:${bridgeId}`, BRIDGE_DEFAULT_RATE_PER_MIN);
    if (!rl.ok) {
      return buildError(c, 'too_many_requests', 'rate limit exceeded', {
        'retry-after': String(rl.retryAfterSec),
      });
    }

    // reject oversized bodies before parseStrict (and before any
    // pipeline work) so the bridge submitter sees a typed `message_too_large`.
    // The check sits after HMAC auth so we don't leak the rejection to
    // unauthenticated callers, but before any parsing per the contract.
    if (bodyBytes.byteLength > MAX_MESSAGE_SIZE_VERIFIED) {
      return buildError(
        c,
        'message_too_large',
        `message ${bodyBytes.byteLength} bytes exceeds ${MAX_MESSAGE_SIZE_VERIFIED}`,
      );
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
        bridgeId,
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
  const rendered = await renderMessageBodies(c.env, msg, raw, row.r2_key, { listMode: false });
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
    const rendered = await renderMessageBodies(c.env, msg, raw, row.r2_key, { listMode: true });
    data.push(rendered);
  }
  return c.json({ data, next_offset: hasMore ? offset + limit : null });
});

// The previous `GET /v1/messages/:id/attachments/:n` handler that minted
// signed URLs has been removed. Attachment bytes are now served by the
// R2 public custom domain `r2.mail.plrs.im`; `attachment.url` in the
// `GET /v1/messages/:id` response points there directly.

// ---------- W9 — Outbound reply-header synthesis ----------

const MAX_REFERENCES_IDS = 10;

async function synthesizeReplyHeaders(env: Env, req: SendRequest): Promise<SendRequest> {
  if (!req.in_reply_to_message_id && !req.thread_id) return req;
  const existingHeaders = req.headers ?? {};
  const hasInReplyTo = Object.keys(existingHeaders).some((k) => k.toLowerCase() === 'in-reply-to');
  const hasReferences = Object.keys(existingHeaders).some((k) => k.toLowerCase() === 'references');
  if (hasInReplyTo && hasReferences) return req;

  // Resolve the parent's Message-ID via in_reply_to_message_id first, then
  // fall back to thread_id → newest message in that thread.
  let parent: { header_message_id: string | null; references_header: string | null } | null = null;
  if (req.in_reply_to_message_id) {
    parent = await env.DB.prepare(
      `SELECT header_message_id,
              (SELECT value FROM (SELECT NULL AS value)) AS references_header
       FROM messages WHERE id = ? LIMIT 1`,
    )
      .bind(req.in_reply_to_message_id)
      .first<{ header_message_id: string | null; references_header: string | null }>();
  } else if (req.thread_id) {
    parent = await env.DB.prepare(
      `SELECT header_message_id, NULL AS references_header
       FROM messages WHERE thread_id = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(req.thread_id)
      .first<{ header_message_id: string | null; references_header: string | null }>();
  }
  if (!parent?.header_message_id) return req;
  const parentMsgId = parent.header_message_id;
  const wrap = (m: string): string => (m.startsWith('<') ? m : `<${m}>`);
  const newHeaders: Record<string, string> = { ...existingHeaders };
  if (!hasInReplyTo) newHeaders['In-Reply-To'] = wrap(parentMsgId);
  if (!hasReferences) {
    // Compose the new References by taking the parent's References (if any),
    // appending the parent's Message-ID, and trimming.
    const prior = parent.references_header
      ? parent.references_header.split(/\s+/).filter((s) => s.startsWith('<') && s.endsWith('>'))
      : [];
    const chain = [...prior, wrap(parentMsgId)];
    const trimmed = chain.slice(-MAX_REFERENCES_IDS);
    newHeaders['References'] = trimmed.join(' ');
  }
  return { ...req, headers: newHeaders };
}

// ---------- W9 — Threading endpoints ----------
//
// GET /v1/messages/:id/thread  → all messages with the same thread_id, in
//                                 chronological order.
// GET /v1/threads/:thread_id   → same payload keyed by the thread itself.
//
// thread_id is computed at submit/ingest time by packages/pipeline (see
// `computeThreadId`) and indexed on `(mailbox_id, thread_id, created_at DESC)`,
// so this is a cheap range scan.

async function threadByMessageId(c: Ctx, messageId: string): Promise<Response> {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(messageId)) {
    return buildError(c, 'bad_request', 'invalid message id');
  }
  const auth = await authenticateRead(c);
  if (auth instanceof Response) return auth;
  const apiKey = auth;
  const scopeErr = ensureReadScope(apiKey, { allowAdmin: true });
  if (scopeErr !== true) return buildError(c, 'scope_violation', scopeErr);

  const seed = await c.env.DB.prepare(`SELECT mailbox_id, thread_id FROM messages WHERE id = ?`)
    .bind(messageId)
    .first<{ mailbox_id: string; thread_id: string | null }>();
  if (!seed) return buildError(c, 'not_found', 'message not found');
  if (seed.mailbox_id !== apiKey.mailbox_id && !apiKey.scopes.includes('admin:read')) {
    return buildError(c, 'not_found', 'message not found');
  }
  if (!seed.thread_id) {
    return c.json({ thread_id: null, data: [] });
  }
  return threadByThreadId(c, seed.thread_id, seed.mailbox_id, apiKey);
}

async function threadByThreadId(
  c: Ctx,
  threadId: string,
  mailboxId: string,
  apiKey: AuthenticatedApiKey,
): Promise<Response> {
  const rows = await c.env.DB.prepare(
    `SELECT * FROM messages WHERE mailbox_id = ? AND thread_id = ? ORDER BY created_at ASC LIMIT 500`,
  )
    .bind(mailboxId, threadId)
    .all<MessageRow>()
    .catch(() => ({ results: [] as MessageRow[] }));

  const data: UnifiedMessage[] = [];
  for (const row of rows.results) {
    const raw = await loadR2Bytes(c.env, row.r2_key);
    if (!raw) continue;
    const msg = mimeToMessage(raw, rowMeta(row));
    const rendered = await renderMessageBodies(c.env, msg, raw, row.r2_key, { listMode: true });
    data.push(rendered);
  }
  // mark as used to keep apiKey-derived scope honored for read auditing
  void apiKey;
  return c.json({ thread_id: threadId, count: data.length, data });
}

messages.get('/v1/messages/:id/thread', async (c) => {
  return threadByMessageId(c, c.req.param('id'));
});

messages.get('/v1/threads/:thread_id', async (c) => {
  const auth = await authenticateRead(c);
  if (auth instanceof Response) return auth;
  const apiKey = auth;
  const scopeErr = ensureReadScope(apiKey, { allowAdmin: true });
  if (scopeErr !== true) return buildError(c, 'scope_violation', scopeErr);
  const threadId = c.req.param('thread_id');
  // For non-admin callers, scope to their mailbox. Admin callers can pass
  // ?mailbox_id=… to disambiguate (thread_ids are mailbox-local).
  const url = new URL(c.req.url);
  const mailboxIdParam = url.searchParams.get('mailbox_id');
  const mailboxId =
    mailboxIdParam ?? (apiKey.scopes.includes('admin:read') ? null : apiKey.mailbox_id);
  if (!mailboxId) {
    return buildError(c, 'bad_request', 'mailbox_id query param required for admin reads');
  }
  return threadByThreadId(c, threadId, mailboxId, apiKey);
});
