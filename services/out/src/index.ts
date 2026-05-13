// polaris-email-out: queue consumer that drives Cloudflare's send_email bindings.
// Picks the binding for the message's `from` domain, sends, writes status to D1, emits a
// fanout event.
import type { Env, FanoutEvent, OutboundQueueMessage, SendEmailBinding } from './env.js';

interface MessageBody {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  attachments?: { filename: string; contentType: string; contentB64: string }[];
}

function ulidLite(): string {
  const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const rnd = new Uint8Array(16);
  crypto.getRandomValues(rnd);
  let out = '';
  let t = Date.now();
  for (let i = 9; i >= 0; i--) {
    out = (CROCK[t % 32] ?? '0') + out;
    t = Math.floor(t / 32);
  }
  for (let i = 0; i < 16; i++) out += CROCK[(rnd[i] ?? 0) % 32];
  return out;
}

function b64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

async function loadBody(env: Env, msg: OutboundQueueMessage): Promise<MessageBody | null> {
  if (msg.source === 'json') {
    const obj = await env.R2.get(msg.r2KeyOrInline);
    if (!obj) return null;
    return JSON.parse(await obj.text()) as MessageBody;
  }
  return null;
}

async function setStatus(
  env: Env,
  id: string,
  status: 'sent' | 'bounced' | 'failed',
  meta: { last_error?: string; smtp_response?: string } = {},
): Promise<void> {
  await env.DB.prepare(
    `UPDATE messages
     SET status = ?, last_error = ?, smtp_response = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(status, meta.last_error ?? null, meta.smtp_response ?? null, Date.now(), id)
    .run();
}

async function fanout(env: Env, ev: FanoutEvent): Promise<void> {
  await env.FANOUT_QUEUE.send(ev);
}

export default {
  async queue(batch: MessageBatch<OutboundQueueMessage>, env: Env): Promise<void> {
    for (const m of batch.messages) {
      try {
        await handleOne(env, m.body);
        m.ack();
      } catch (e) {
        // Cloudflare will retry per queue config; log scrubbed.
        // eslint-disable-next-line no-console
        console.error('out: error', m.body.messageId, e instanceof Error ? e.message : 'unknown');
        m.retry();
      }
    }
  },
};

async function handleOne(env: Env, msg: OutboundQueueMessage): Promise<void> {
  // Load body
  const body = await loadBody(env, msg);
  if (!body) {
    await setStatus(env, msg.messageId, 'failed', { last_error: 'r2_body_missing' });
    return;
  }
  // Look up binding_name from domains
  const dom = await env.DB.prepare(`SELECT binding_name FROM domains WHERE name = ?`)
    .bind(msg.fromDomain)
    .first<{ binding_name: string | null }>();
  if (!dom?.binding_name) {
    await setStatus(env, msg.messageId, 'failed', { last_error: 'no_binding_for_domain' });
    await fanout(env, {
      event_id: ulidLite(),
      event: 'message.failed',
      message_id: msg.messageId,
      mailbox_id: null,
      service_id: null,
      created_at: Date.now(),
      data: { reason: 'no_binding_for_domain', from_domain: msg.fromDomain },
    });
    return;
  }
  // Test mode: skip the binding call, emit a synthetic event.
  if (msg.mode === 'test') {
    await setStatus(env, msg.messageId, 'sent');
    await fanout(env, {
      event_id: ulidLite(),
      event: 'message.sent',
      message_id: msg.messageId,
      mailbox_id: null,
      service_id: null,
      created_at: Date.now(),
      data: { test: true, recipients: body.to.length },
    });
    return;
  }
  // Live send
  const bindingName = dom.binding_name;
  const binding = (env as unknown as Record<string, SendEmailBinding | undefined>)[bindingName];
  if (!binding || typeof binding.send !== 'function') {
    await setStatus(env, msg.messageId, 'failed', { last_error: `binding ${bindingName} not configured` });
    return;
  }
  try {
    const result = await binding.send({
      from: body.from,
      to: body.to,
      ...(body.cc ? { cc: body.cc } : {}),
      ...(body.bcc ? { bcc: body.bcc } : {}),
      ...(body.replyTo ? { replyTo: body.replyTo } : {}),
      subject: body.subject,
      ...(body.html ? { html: body.html } : {}),
      ...(body.text ? { text: body.text } : {}),
      ...(body.headers ? { headers: body.headers } : {}),
      ...(body.attachments
        ? {
            attachments: body.attachments.map((a) => ({
              filename: a.filename,
              contentType: a.contentType,
              content: b64ToArrayBuffer(a.contentB64),
            })),
          }
        : {}),
    });
    if (result.permanent_bounces.length) {
      await setStatus(env, msg.messageId, 'bounced', {
        last_error: 'permanent_bounce',
        smtp_response: result.permanent_bounces.join(','),
      });
      await fanout(env, {
        event_id: ulidLite(),
        event: 'message.bounced',
        message_id: msg.messageId,
        mailbox_id: null,
        service_id: null,
        created_at: Date.now(),
        data: { permanent_bounces: result.permanent_bounces },
      });
    } else {
      await setStatus(env, msg.messageId, 'sent');
      await fanout(env, {
        event_id: ulidLite(),
        event: 'message.sent',
        message_id: msg.messageId,
        mailbox_id: null,
        service_id: null,
        created_at: Date.now(),
        data: { delivered: result.delivered, queued: result.queued },
      });
    }
  } catch (e) {
    const err = e instanceof Error ? e.message : 'unknown';
    if (msg.retries >= 4) {
      await setStatus(env, msg.messageId, 'failed', { last_error: err.slice(0, 256) });
      await fanout(env, {
        event_id: ulidLite(),
        event: 'message.failed',
        message_id: msg.messageId,
        mailbox_id: null,
        service_id: null,
        created_at: Date.now(),
        data: { reason: err.slice(0, 256), retries: msg.retries },
      });
    } else {
      // Let the queue retry; bump retries so we eventually mark failed.
      throw e;
    }
  }
}
