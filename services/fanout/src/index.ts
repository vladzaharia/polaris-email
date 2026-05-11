// polaris-email-fanout: queue consumer that signs + POSTs webhook events.
import { sign, generateNonce } from '@polaris-email/hmac';
import { safeFetch } from './ssrf.js';

interface Env {
  DB: D1Database;
  BRIDGE_TAILNET_HOST: string;
}

interface FanoutEvent {
  event_id: string;
  event: string;
  message_id: string;
  mailbox_id: string | null;
  service_id: string | null;
  created_at: number;
  data: Record<string, unknown>;
}

interface SubRow {
  id: string;
  url: string;
  kind: 'external' | 'tailnet' | 'bridge';
  secret: string;
  secret_prev: string | null;
  secret_prev_expires_at: number | null;
  events: string;
  paused_at: number | null;
}

export default {
  async queue(
    batch: MessageBatch<FanoutEvent>,
    env: Env,
    _ctx: ExecutionContext,
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
  },
};

async function deliver(env: Env, ev: FanoutEvent): Promise<void> {
  // Find subscribers matching the event for the relevant mailbox/service.
  // Subscribers can match by mailbox_id, or by service_id (mailbox null + service set),
  // or be global (both null).
  const rows = await env.DB.prepare(
    `SELECT id, url, kind, secret, secret_prev, secret_prev_expires_at, events, paused_at
     FROM webhook_subs
     WHERE paused_at IS NULL
       AND (mailbox_id = ? OR (mailbox_id IS NULL AND (service_id = ? OR service_id IS NULL)))`,
  )
    .bind(ev.mailbox_id, ev.service_id)
    .all<SubRow>();
  if (!rows.results.length) return;
  for (const sub of rows.results) {
    let events: string[] = [];
    try {
      events = JSON.parse(sub.events) as string[];
    } catch {
      continue;
    }
    if (!events.includes(ev.event)) continue;
    await deliverToSub(env, ev, sub);
  }
}

async function deliverToSub(env: Env, ev: FanoutEvent, sub: SubRow): Promise<void> {
  // Ensure a message_deliveries row exists.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO message_deliveries
       (message_id, sub_id, status, attempts, next_attempt_at)
     VALUES (?, ?, 'pending', 0, ?)`,
  )
    .bind(ev.message_id, sub.id, Date.now())
    .run();
  const payload = {
    event_id: ev.event_id,
    event: ev.event,
    created_at: ev.created_at,
    data: ev.data,
  };
  const body = JSON.stringify(payload);
  const u = new URL(sub.url);
  const ts = String(Date.now());
  const nonce = generateNonce();
  const secret = sub.secret; // current secret signs new deliveries
  const sig = await sign(
    {
      direction: 'polaris-webhook.v1',
      method: 'POST',
      path: u.pathname,
      query: u.search,
      ts,
      nonce,
      body,
    },
    secret,
  );
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-polaris-ts': ts,
    'x-polaris-nonce': nonce,
    'x-polaris-sig': sig,
    'x-polaris-event-id': ev.event_id,
    'x-polaris-event': ev.event,
  };
  const result = await safeFetch(sub.url, sub.kind, env.BRIDGE_TAILNET_HOST, {
    method: 'POST',
    headers,
    body,
    timeoutMs: 10_000,
    maxResponseBytes: 1024 * 1024,
  });
  if (result.ok) {
    await env.DB.prepare(
      `UPDATE message_deliveries
       SET status = 'succeeded', succeeded_at = ?, last_response_code = ?
       WHERE message_id = ? AND sub_id = ?`,
    )
      .bind(Date.now(), result.status, ev.message_id, sub.id)
      .run();
  } else {
    // Bump attempts, mark failed or DLQ depending on prior attempts.
    const prev = await env.DB.prepare(
      `SELECT attempts FROM message_deliveries WHERE message_id = ? AND sub_id = ?`,
    )
      .bind(ev.message_id, sub.id)
      .first<{ attempts: number }>();
    const attempts = (prev?.attempts ?? 0) + 1;
    const finalStatus = attempts >= 6 ? 'dlq' : 'failed';
    await env.DB.prepare(
      `UPDATE message_deliveries
       SET status = ?, attempts = ?, last_error = ?, last_response_code = ?,
           next_attempt_at = ?, failed_at = ?
       WHERE message_id = ? AND sub_id = ?`,
    )
      .bind(
        finalStatus,
        attempts,
        result.body.slice(0, 256),
        result.status,
        Date.now() + Math.min(60_000 * 2 ** attempts, 60 * 60_000),
        Date.now(),
        ev.message_id,
        sub.id,
      )
      .run();
    if (finalStatus !== 'dlq') throw new Error(`webhook ${sub.id} failed ${result.status}`);
  }
}
