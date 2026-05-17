// polaris-email-fanout: queue consumer that signs + POSTs webhook events.
//
// Canonical envelope:
//   {
//     event_id,
//     event: 'message.received' | 'message.sent' | 'message.delivered'
//          | 'message.bounced' | 'message.failed',
//     occurred_at,
//     message: <full Message JSON via mimeToMessage on the row>,
//   }
//
// Signature header: `X-Polaris-Sig: <hex>` (bare lowercase hex — no prefix).
//
// On the last successful `message_deliveries` row for a message, this consumer
// also flips `messages.status='delivered'` and stamps `delivered_at`
// (terminal-success bookkeeping).
//
// Absorbed from the standalone `services/fanout` Worker. The
// `polaris-email-api` Worker now binds the FANOUT_QUEUE consumer directly and
// routes batches to `fanoutQueueConsumer` from its top-level `queue` export.
import { sign, generateNonce, sha256Hex } from '@polaris-email/hmac';
import { ulid } from '@polaris-email/ids';
import { extractAttachmentParts, mimeToMessage, type MessageRowMeta } from '@polaris-email/mime';
import type { Env } from '../env.js';
import { r2PublicUrl, attachmentR2Key } from '../lib/r2-public-url.js';
import { safeFetch } from './ssrf.js';

export interface FanoutEvent {
  /** Queue message envelope version. Consumers MUST accept any value
   *  ≤ their compiled-in maximum and fall through on unknown future
   *  versions. Producers always emit the current version. */
  version?: 1;
  event_id: string;
  event:
    | 'message.received'
    | 'message.sent'
    | 'message.delivered'
    | 'message.bounced'
    | 'message.failed';
  message_id: string;
  mailbox_id: string | null;
  /** Optional, present on outbound events for back-compat; ignored for v2. */
  domain_id?: string | null;
  /** Optional: when set, only this webhook_sub will receive the event. */
  webhook_sub_id?: string;
  created_at: number;
  data?: Record<string, unknown>;
}

interface SubRow {
  id: string;
  url: string;
  kind: 'external' | 'tailnet';
  secret: string;
  secret_prev: string | null;
  events: string;
  paused_at: string | null;
}

interface MessageRowFull extends MessageRowMeta {
  r2_key: string;
}

export async function fanoutQueueConsumer(
  batch: MessageBatch<FanoutEvent>,
  env: Env,
): Promise<void> {
  for (const m of batch.messages) {
    try {
      await deliver(env, m.body);
      m.ack();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('fanout: error', e instanceof Error ? e.message : 'unknown');
      m.retry();
    }
  }
}

async function loadMessageRow(env: Env, id: string): Promise<MessageRowFull | null> {
  return await env.DB.prepare(
    `SELECT id, mailbox_id, direction, status, r2_key, thread_id, header_message_id,
            auth_spf, auth_dkim, auth_dmarc, auth_remote_ip,
            body_bytes, attachments_total_bytes,
            received_at_bridge, received_at_api, queued_at, sending_at, sent_at,
            delivered_at, failed_at, bounce_metadata, last_error, created_at
       FROM messages WHERE id = ? LIMIT 1`,
  )
    .bind(id)
    .first<MessageRowFull>();
}

async function loadRawMime(env: Env, key: string): Promise<Uint8Array | null> {
  const obj = await env.R2.get(key);
  if (!obj) return null;
  const buf = await obj.arrayBuffer();
  return new Uint8Array(buf);
}

async function buildEnvelope(
  env: Env,
  ev: FanoutEvent,
): Promise<{ body: string; messageStatus: string } | null> {
  const row = await loadMessageRow(env, ev.message_id);
  if (!row) return null;
  const raw = await loadRawMime(env, row.r2_key);
  if (!raw) return null;
  const message = mimeToMessage(raw, row);
  // B5: every webhook envelope ships `body_url` + per-attachment `url`
  // pointing at the public R2 custom domain. Subscribers fetch bytes
  // directly without HMAC.
  message.body_url = r2PublicUrl(env, row.r2_key);
  const parts = extractAttachmentParts(raw);
  for (let i = 0; i < (message.attachments?.length ?? 0); i++) {
    const part = parts[i];
    if (!part) continue;
    const attSha = await sha256Hex(part.bytes);
    message.attachments[i]!.url = r2PublicUrl(
      env,
      attachmentR2Key(attSha, part.filename),
      part.filename,
    );
  }
  const envelope = {
    event_id: ev.event_id,
    event: ev.event,
    occurred_at: new Date(ev.created_at).toISOString(),
    message,
  };
  return { body: JSON.stringify(envelope), messageStatus: row.status };
}

async function deliver(env: Env, ev: FanoutEvent): Promise<void> {
  // Resolve subs:
  //   * If webhook_sub_id is on the event, deliver to just that sub (inbound
  //     fanout list path).
  //   * Otherwise resolve by mailbox_id (outbound `message.sent/bounced/failed`).
  let rows: SubRow[];
  if (ev.webhook_sub_id) {
    const r = await env.DB.prepare(
      `SELECT id, url, kind, secret, secret_prev, events, paused_at
         FROM webhook_subs
        WHERE id = ?1
          AND paused_at IS NULL
          AND disabled_at IS NULL
        LIMIT 1`,
    )
      .bind(ev.webhook_sub_id)
      .all<SubRow>();
    rows = r.results;
  } else {
    const r = await env.DB.prepare(
      `SELECT id, url, kind, secret, secret_prev, events, paused_at
         FROM webhook_subs
        WHERE mailbox_id = ?1
          AND paused_at IS NULL
          AND disabled_at IS NULL`,
    )
      .bind(ev.mailbox_id)
      .all<SubRow>();
    rows = r.results;
  }
  if (!rows.length) return;
  const env2 = await buildEnvelope(env, ev);
  if (!env2) return;

  for (const sub of rows) {
    let events: string[] = [];
    try {
      events = JSON.parse(sub.events) as string[];
    } catch {
      continue;
    }
    if (!events.includes(ev.event)) continue;
    await deliverToSub(env, ev, sub, env2.body);
  }
}

async function deliverToSub(env: Env, ev: FanoutEvent, sub: SubRow, body: string): Promise<void> {
  const nowIso = new Date().toISOString();
  // Idempotent insert. INSERT OR REPLACE would clobber the attempts counter
  // on retries, so we keep INSERT OR IGNORE: the row appears once, and
  // subsequent retries no-op here and only mutate via the atomic UPDATE
  // below.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO message_deliveries
       (message_id, webhook_sub_id, status, attempts, next_attempt_at, created_at)
     VALUES (?, ?, 'pending', 0, ?, ?)`,
  )
    .bind(ev.message_id, sub.id, nowIso, nowIso)
    .run();

  const u = new URL(sub.url);
  const ts = String(Date.now());
  const nonce = generateNonce();
  // Per-attempt delivery_id lets subscribers dedupe at the
  // (message_id, delivery_id) tuple even if the same event_id is retried.
  const deliveryId = ulid();
  const sig = await sign(
    {
      direction: 'polaris-webhook',
      method: 'POST',
      path: u.pathname,
      query: u.search,
      ts,
      nonce,
      body,
    },
    sub.secret,
  );
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-polaris-ts': ts,
    'x-polaris-nonce': nonce,
    'x-polaris-sig': sig,
    'x-polaris-event-id': ev.event_id,
    'x-polaris-event': ev.event,
    'x-polaris-delivery-id': deliveryId,
  };
  const t0 = Date.now();
  const result = await safeFetch(sub.url, sub.kind, {
    method: 'POST',
    headers,
    body,
    timeoutMs: 10_000,
    maxResponseBytes: 1024 * 1024,
  });
  const latencyMs = Date.now() - t0;
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      event: 'webhook_delivery',
      webhook_sub_id: sub.id,
      message_id: ev.message_id,
      delivery_id: deliveryId,
      status: result.ok ? 'succeeded' : 'failed',
      http_status: result.status,
      latency_ms: latencyMs,
    }),
  );
  if (result.ok) {
    await env.DB.prepare(
      `UPDATE message_deliveries
         SET status = 'succeeded', last_response_code = ?
       WHERE message_id = ? AND webhook_sub_id = ?`,
    )
      .bind(result.status, ev.message_id, sub.id)
      .run();

    // If every delivery for this message is now succeeded, flip
    // messages.status='delivered' and stamp delivered_at.
    await maybeMarkDelivered(env, ev.message_id);
    return;
  }

  // 4a.2: atomic attempts increment. Two concurrent fanout retries used to
  // both read `attempts=N` and both write `attempts=N+1` (instead of N+2),
  // sticking the message at `sending` indefinitely. UPDATE ... RETURNING
  // serialises the read+write and guarantees a strictly monotonic counter.
  const incremented = await env.DB.prepare(
    `UPDATE message_deliveries
       SET attempts = attempts + 1,
           last_error = ?1,
           last_response_code = ?2
     WHERE message_id = ?3 AND webhook_sub_id = ?4
     RETURNING attempts`,
  )
    .bind(result.body.slice(0, 256), result.status, ev.message_id, sub.id)
    .first<{ attempts: number }>();
  const attempts = incremented?.attempts ?? 1;
  const isTerminal = attempts >= 6;
  const finalStatus = isTerminal ? 'dlq' : 'failed';
  const nextAttemptAt = isTerminal
    ? null
    : new Date(Date.now() + Math.min(60_000 * 2 ** attempts, 60 * 60_000)).toISOString();
  await env.DB.prepare(
    `UPDATE message_deliveries
       SET status = ?, next_attempt_at = ?
     WHERE message_id = ? AND webhook_sub_id = ?`,
  )
    .bind(finalStatus, nextAttemptAt, ev.message_id, sub.id)
    .run();
  if (isTerminal) {
    const bodyHash = await sha256Hex(new TextEncoder().encode(body));
    await env.DB.prepare(
      `INSERT INTO webhook_dlq
         (id, message_id, webhook_sub_id, payload_sha256, last_status_code,
          last_error, attempts, dlq_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        ulid(),
        ev.message_id,
        sub.id,
        bodyHash,
        result.status,
        result.body.slice(0, 256),
        attempts,
        nowIso,
      )
      .run();
    return;
  }
  throw new Error(`webhook ${sub.id} failed ${result.status}`);
}

/**
 * 4a.2: atomic CAS terminal-success bookkeeping. The SELECT side reads
 * the up-to-date delivery aggregates; the UPDATE only flips one row and
 * uses a `status IN ('sent','sending')` precondition so two concurrent
 * callers cannot both flip (idempotency). The previous `status !=
 * 'delivered'` allowed flips from any other terminal state which could
 * silently overwrite a `bounced` or `failed` outcome on a late retry.
 */
async function maybeMarkDelivered(env: Env, messageId: string): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT
        SUM(CASE WHEN status != 'succeeded' THEN 1 ELSE 0 END) AS unfinished,
        COUNT(*) AS total
       FROM message_deliveries
      WHERE message_id = ?`,
  )
    .bind(messageId)
    .first<{ unfinished: number | null; total: number | null }>();
  if (!row || !row.total || row.total === 0) return;
  if ((row.unfinished ?? 0) > 0) return;
  const nowIso = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE messages
       SET status = 'delivered', delivered_at = ?
     WHERE id = ? AND status IN ('sent','sending','received')`,
  )
    .bind(nowIso, messageId)
    .run();
}
