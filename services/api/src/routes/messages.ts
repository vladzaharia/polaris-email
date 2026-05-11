// POST /v1/messages — outbound send endpoint.
import { Hono } from 'hono';
import { SendMessageRequest } from '@polaris-email/schema';
import { bodyText, hmacAuth, requireScope } from '../auth.js';
import { audit } from '../audit.js';
import { buildError } from '../errors.js';
import type { Env } from '../env.js';
import { ulid } from '../ids.js';
import { hmacRecipients } from '../hashing.js';
import { rateLimit } from '../rate-limit.js';
import { matchesSenderScope } from '../scopes.js';
import { checkIdempotency, recordIdempotency } from '../idempotency.js';

export const messages = new Hono<{ Bindings: Env }>();

messages.use('/v1/messages', hmacAuth('polaris-api.v1'));
messages.use('/v1/messages', requireScope('send'));

messages.post('/v1/messages', async (c) => {
  const key = c.get('apiKey');
  const text = bodyText(c);
  // Validate JSON body
  let parsed;
  try {
    parsed = SendMessageRequest.parse(JSON.parse(text));
  } catch (e) {
    return buildError(c, 'bad_request', e instanceof Error ? e.message : 'invalid body');
  }
  // Sender scope check
  let scopes;
  try {
    scopes = JSON.parse(key.sender_scopes_raw);
  } catch {
    return buildError(c, 'forbidden', 'sender_scopes parse failed');
  }
  if (!matchesSenderScope(parsed.from, scopes)) {
    return buildError(c, 'scope_violation', `from address ${parsed.from} outside sender_scopes`);
  }
  // Domain verified?
  const fromDomain = parsed.from.split('@')[1]?.toLowerCase() ?? '';
  const domainRow = await c.env.DB.prepare(
    `SELECT name, binding_name, verified_at, disabled_at FROM domains
     WHERE name = ? AND (direction = 'out' OR direction = 'both')`,
  )
    .bind(fromDomain)
    .first<{ name: string; binding_name: string | null; verified_at: number | null; disabled_at: number | null }>();
  if (!domainRow || !domainRow.verified_at || domainRow.disabled_at) {
    return buildError(c, 'domain_not_verified', `${fromDomain} not verified`);
  }
  // Rate limit
  const rl = await rateLimit(c.env, key.key_id, key.rate_limit_per_min);
  if (!rl.ok) {
    return buildError(c, 'rate_limited', 'too many requests', {
      'retry-after': String(rl.retryAfterSec),
    });
  }
  // Idempotency
  const idemHeader = c.req.header('idempotency-key');
  const idem = await checkIdempotency(c.env, key.key_id, idemHeader, text);
  if (idem.state === 'conflict') return buildError(c, 'idempotency_conflict', 'body differs');
  if (idem.state === 'replay') {
    return new Response(
      JSON.stringify({
        messageId: idem.original.messageId,
        queuedAt: idem.original.queuedAt,
        mode: idem.original.mode,
      }),
      {
        status: 202,
        headers: {
          'content-type': 'application/json',
          'x-polaris-idempotent': 'replay',
        },
      },
    );
  }
  // Get tenant pepper for to_hash
  let pepper = '';
  if (key.service_id) {
    const svc = await c.env.DB.prepare(`SELECT to_hash_pepper FROM services WHERE id = ?`)
      .bind(key.service_id)
      .first<{ to_hash_pepper: string }>();
    pepper = svc?.to_hash_pepper ?? '';
  }
  const allRecipients = [...parsed.to, ...(parsed.cc ?? []), ...(parsed.bcc ?? [])];
  const toHash = pepper ? await hmacRecipients(allRecipients, pepper) : null;

  // Store full body in R2 keyed by ulid + random suffix.
  const id = ulid();
  const rnd = new Uint8Array(16);
  crypto.getRandomValues(rnd);
  const r2Key = `out/${key.service_id ?? 'unknown'}/${id}-${Array.from(rnd, (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')}.json`;
  await c.env.R2.put(r2Key, text, {
    httpMetadata: { contentType: 'application/json' },
  });

  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO messages
       (id, mailbox_id, service_id, direction, mode, status, from_addr, to_hash,
        subject, size_bytes, r2_key, category, idempotency_key, created_at, updated_at)
     VALUES (?, NULL, ?, 'out', ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      key.service_id,
      parsed.mode,
      parsed.from,
      toHash,
      parsed.subject.slice(0, 256),
      text.length,
      r2Key,
      parsed.category,
      idemHeader ?? null,
      now,
      now,
    )
    .run();

  // Enqueue for the out Worker
  await c.env.OUTBOUND_QUEUE.send({
    messageId: id,
    source: 'json',
    r2KeyOrInline: r2Key,
    fromDomain,
    fromAddress: parsed.from,
    mode: parsed.mode,
    retries: 0,
  });
  await recordIdempotency(c.env, key.key_id, idemHeader, text, {
    messageId: id,
    queuedAt: now,
    mode: parsed.mode,
  });

  // Usage event (sampled; we keep all in v1 for forensic completeness).
  c.executionCtx.waitUntil(
    c.env.DB.prepare(
      `INSERT INTO api_key_usage (key_id, ts, ip, user_agent, cf_ray, request_id, route, result_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        key.key_id,
        now,
        c.req.header('cf-connecting-ip') ?? null,
        c.req.header('user-agent')?.slice(0, 256) ?? null,
        c.req.header('cf-ray') ?? null,
        c.get('requestId'),
        'POST /v1/messages',
        '202',
      )
      .run(),
  );

  // No audit row for sends — sends would dominate the log. Aggregate via api_key_usage instead.

  void audit; // imported for use by admin handlers

  return new Response(
    JSON.stringify({ messageId: id, queuedAt: now, mode: parsed.mode }),
    {
      status: 202,
      headers: {
        'content-type': 'application/json',
        'x-request-id': c.get('requestId'),
      },
    },
  );
});
