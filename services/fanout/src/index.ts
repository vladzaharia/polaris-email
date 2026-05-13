// polaris-email-fanout: queue consumer that signs + POSTs webhook events.
//
// Subscribers in webhook_subs route by (tenant_id, domain_id). A sub with
// domain_id = NULL matches any domain for that tenant; a sub with both null
// is account-global. Signed delivery uses the polaris-webhook.v1 HMAC scheme.
import { sign, generateNonce } from '@polaris-email/hmac';
import { ulid } from '@polaris-email/ids';
import { safeFetch } from './ssrf.js';

interface Env {
  DB: D1Database;
}

interface FanoutEvent {
  event_id: string;
  event: string;
  message_id: string;
  tenant_id: string | null;
  domain_id: string | null;
  created_at: number;
  data: Record<string, unknown>;
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
  // Subs match when (tenant_id matches OR sub.tenant_id is NULL)
  //              AND (domain_id matches OR sub.domain_id is NULL)
  //              AND sub is not paused and not disabled.
  const rows = await env.DB.prepare(
    `SELECT id, url, kind, secret, secret_prev, events, paused_at
     FROM webhook_subs
     WHERE paused_at IS NULL
       AND disabled_at IS NULL
       AND (tenant_id = ?1 OR tenant_id IS NULL)
       AND (domain_id = ?2 OR domain_id IS NULL)`,
  )
    .bind(ev.tenant_id, ev.domain_id)
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
  const nowIso = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO message_deliveries
       (message_id, webhook_sub_id, status, attempts, next_attempt_at, created_at)
     VALUES (?, ?, 'pending', 0, ?, ?)`,
  )
    .bind(ev.message_id, sub.id, nowIso, nowIso)
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
    sub.secret,
  );
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-polaris-ts': ts,
    'x-polaris-nonce': nonce,
    'x-polaris-sig': sig,
    'x-polaris-event-id': ev.event_id,
    'x-polaris-event': ev.event,
  };
  const result = await safeFetch(sub.url, sub.kind, {
    method: 'POST',
    headers,
    body,
    timeoutMs: 10_000,
    maxResponseBytes: 1024 * 1024,
  });
  if (result.ok) {
    await env.DB.prepare(
      `UPDATE message_deliveries
       SET status = 'succeeded', last_response_code = ?
       WHERE message_id = ? AND webhook_sub_id = ?`,
    )
      .bind(result.status, ev.message_id, sub.id)
      .run();
    return;
  }
  // Failed: bump attempts and either schedule a retry or move to DLQ.
  const prev = await env.DB.prepare(
    `SELECT attempts FROM message_deliveries WHERE message_id = ? AND webhook_sub_id = ?`,
  )
    .bind(ev.message_id, sub.id)
    .first<{ attempts: number }>();
  const attempts = (prev?.attempts ?? 0) + 1;
  const isTerminal = attempts >= 6;
  const finalStatus = isTerminal ? 'dlq' : 'failed';
  const nextAttemptAt = isTerminal
    ? null
    : new Date(Date.now() + Math.min(60_000 * 2 ** attempts, 60 * 60_000)).toISOString();
  await env.DB.prepare(
    `UPDATE message_deliveries
     SET status = ?, attempts = ?, last_error = ?, last_response_code = ?,
         next_attempt_at = ?
     WHERE message_id = ? AND webhook_sub_id = ?`,
  )
    .bind(
      finalStatus,
      attempts,
      result.body.slice(0, 256),
      result.status,
      nextAttemptAt,
      ev.message_id,
      sub.id,
    )
    .run();
  if (isTerminal) {
    // Persist the terminal failure so /v1/admin/webhook-dlq can list it.
    const bodyHash = await sha256Hex(body);
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

async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
