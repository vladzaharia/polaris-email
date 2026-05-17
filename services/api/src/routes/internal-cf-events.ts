// W3 — Cloudflare Email Service bounce webhook listener.
//
// CF Email Service posts bounce events to this endpoint (mounted at
// /v1/internal/cf-events/bounce). The endpoint is signed with a separate
// HMAC secret CF_EVENT_HMAC so that:
//   * the admin api-key surface stays free of CF-event traffic
//   * the secret can be rotated independently from operator API keys
//   * a leaked admin key cannot inject synthetic bounce events to falsely
//     suppress recipients
//
// V1 contract (subject to CF's actual webhook spec — finalise during
// integration tests against the live CF event format):
//
//   POST /v1/internal/cf-events/bounce
//   Headers:
//     X-CF-Event-Sig: <hex hmac of body using CF_EVENT_HMAC>
//     X-CF-Event-Ts:  <ms since epoch>
//     X-CF-Event-Id:  <opaque event id for idempotency>
//   Body: { type: 'hard_bounce' | 'soft_bounce' | 'complaint',
//           message_id: '<message-id from messages.id>',
//           recipient: 'bounced@example.com',
//           smtp_code: '550 5.1.1 User unknown',
//           reported_at: <ms since epoch> }
//
// Actions per event:
//   1. Idempotency by X-CF-Event-Id (KV cache, 7d TTL).
//   2. Update `messages` row (status=bounced when hard_bounce; populate
//      bounce_metadata).
//   3. Insert an `abuse_events` row tagged 'hard_bounce' / 'spam_complaint'.
//   4. Insert a recipient `suppressions` row (when hard_bounce / complaint).
//   5. Fire an admin alert when severity warrants (we don't alert on
//      every bounce — only on bursts; the W2c sender-threshold cron will
//      pick up sustained bounce volume).

import { Hono } from 'hono';
import { ulid } from '@polaris-email/ids';
import { normalizeAddress } from '@polaris-email/suppressions';
import { buildAuditInsert } from '../audit.js';
import { buildError } from '../errors.js';
import type { Env } from '../env.js';

export const internalCfEvents = new Hono<{ Bindings: Env }>();

interface CfBounceEvent {
  type: 'hard_bounce' | 'soft_bounce' | 'complaint';
  message_id: string;
  recipient: string;
  smtp_code?: string;
  reported_at?: number;
}

async function hmacVerify(body: string, sig: string, secret: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  const expected = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const arr = new Uint8Array(expected);
  let hex = '';
  for (const b of arr) hex += b.toString(16).padStart(2, '0');
  // Constant-time compare. The unsigned input is hex; xor-compare.
  if (hex.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

internalCfEvents.post('/v1/internal/cf-events/bounce', async (c) => {
  const secret = c.env.CF_EVENT_HMAC;
  if (!secret) return buildError(c, 'degraded', 'CF_EVENT_HMAC not configured');
  const sig = c.req.header('x-cf-event-sig');
  const ts = c.req.header('x-cf-event-ts');
  const eventId = c.req.header('x-cf-event-id');
  if (!sig || !ts || !eventId) {
    return buildError(c, 'bad_request', 'missing required CF event headers');
  }

  // Clock skew window: ±10 minutes.
  const tsNum = Number.parseInt(ts, 10);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > 10 * 60_000) {
    return buildError(c, 'clock_skew', 'event timestamp out of bounds');
  }

  const body = await c.req.text();
  if (!(await hmacVerify(body, sig, secret))) {
    return buildError(c, 'bad_signature', 'invalid CF event signature');
  }

  // Idempotency check.
  const idemKey = `cf-event:${eventId}`;
  const seen = await c.env.KV_IDEMPOTENCY.get(idemKey);
  if (seen) {
    return c.json({ status: 'replay', event_id: eventId, applied: false });
  }

  let event: CfBounceEvent;
  try {
    event = JSON.parse(body) as CfBounceEvent;
  } catch {
    return buildError(c, 'bad_request', 'invalid event body');
  }
  if (!event.type || !event.message_id || !event.recipient) {
    return buildError(c, 'bad_request', 'missing required event fields');
  }

  const nowIso = new Date().toISOString();
  const recipNormalized = normalizeAddress(event.recipient);

  // 1. Update messages row when the event indicates terminal failure.
  //    Soft bounces don't flip status; CF Workers Queues retries handle that.
  const terminalStatus = event.type === 'hard_bounce' ? 'bounced' : null;
  if (terminalStatus) {
    await c.env.DB.prepare(
      `UPDATE messages SET status = ?, bounced_at = ?, bounce_metadata = ?
       WHERE id = ? AND status NOT IN ('delivered', 'bounced')`,
    )
      .bind(
        terminalStatus,
        nowIso,
        JSON.stringify({
          source: 'cf_bounce_webhook',
          type: event.type,
          recipient: event.recipient,
          smtp_code: event.smtp_code ?? null,
        }),
        event.message_id,
      )
      .run();
  }

  // 2. Resolve the sender principal for this message so abuse_events credits
  //    the right party. Best-effort: when the messages row is missing or the
  //    from_addr doesn't map to a known mail_domains row, we still write a
  //    sender-anonymous event. messages doesn't carry a domain_id column
  //    we derive it from `from_addr` via mail_domains.
  const msgRow = await c.env.DB.prepare(
    `SELECT mailbox_id, from_addr FROM messages WHERE id = ? LIMIT 1`,
  )
    .bind(event.message_id)
    .first<{ mailbox_id: string | null; from_addr: string | null }>();
  let derivedDomainId: string | null = null;
  if (msgRow?.from_addr) {
    const atIdx = msgRow.from_addr.lastIndexOf('@');
    if (atIdx > 0) {
      const fromDomain = msgRow.from_addr.slice(atIdx + 1).toLowerCase();
      const dom = await c.env.DB.prepare(`SELECT id FROM mail_domains WHERE name = ? LIMIT 1`)
        .bind(fromDomain)
        .first<{ id: string }>();
      derivedDomainId = dom?.id ?? null;
    }
  }

  // 3. Insert abuse_events + (when terminal) suppressions row, in a batch.
  const classification = event.type === 'complaint' ? 'spam_complaint' : 'hard_bounce';
  const weight = event.type === 'complaint' ? 3 : 1;
  const auditInsert = await buildAuditInsert(c.env, {
    actor: 'system:cf-bounce-webhook',
    action: 'abuse_event.record',
    target: event.message_id,
    meta: {
      cf_event_id: eventId,
      type: event.type,
      recipient: recipNormalized?.normalized ?? event.recipient,
      smtp_code: event.smtp_code ?? null,
    },
  });

  const abuseId = ulid();
  let suppressionId: string | null = null;
  const stmts = [];
  if (recipNormalized && (event.type === 'hard_bounce' || event.type === 'complaint')) {
    suppressionId = ulid();
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO suppressions
           (id, entity_type, address_normalized, address_local, address_domain,
            scope, scope_target, reason, source, source_ref, severity,
            created_at, expires_at, disabled_at, disabled_reason, notes)
          VALUES (?, 'recipient', ?, ?, ?, 'global', NULL, ?, 'cf_email_service', ?, ?, ?, NULL, NULL, NULL, NULL)
          ON CONFLICT DO NOTHING`,
      ).bind(
        suppressionId,
        recipNormalized.normalized,
        recipNormalized.local,
        recipNormalized.domain,
        classification,
        abuseId,
        event.type === 'complaint' ? 'critical' : 'warn',
        nowIso,
      ),
    );
  }
  stmts.push(
    c.env.DB.prepare(
      `INSERT INTO abuse_events
         (id, sender_address,
          sender_principal_mailbox_id, sender_principal_sender_id,
          sender_principal_domain_id,
          classification, source, source_ref, weight,
          reporter_address, reporter_org, original_message_id,
          raw_meta, caused_suppression_id, reported_at, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, 'cf_bounce_webhook', ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
    ).bind(
      abuseId,
      msgRow?.from_addr ?? null,
      msgRow?.mailbox_id ?? null,
      derivedDomainId,
      classification,
      eventId,
      weight,
      event.message_id,
      JSON.stringify({ event, smtp_code: event.smtp_code }),
      suppressionId,
      new Date(event.reported_at ?? Date.now()).toISOString(),
      nowIso,
    ),
  );
  stmts.push(auditInsert.statement);
  await c.env.DB.batch(stmts);

  // Idempotency mark — 7-day TTL covers any reasonable CF retry window.
  await c.env.KV_IDEMPOTENCY.put(idemKey, abuseId, { expirationTtl: 7 * 24 * 3600 });

  return c.json({
    status: 'ok',
    event_id: eventId,
    abuse_event_id: abuseId,
    suppression_id: suppressionId,
    message_status_updated: !!terminalStatus,
  });
});
