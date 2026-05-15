// polaris-email-out: queue consumer that drives Cloudflare's send_email bindings.
//
// The queue handler reads canonical MIME bytes from R2 (via messages.r2_key,
// content-addressed), hands them to the per-domain `send_email` binding,
// writes the canonical status to D1 (messages table), and emits a fanout
// event.
//
// The `delivered` transition is the responsibility of the FANOUT_QUEUE
// consumer hosted in services/api (see services/api/src/queue/fanout.ts —
// folded in during phase B1). That consumer flips messages.status to
// 'delivered' on the last successful webhook delivery. This worker only
// handles received → sending → sent | bounced | failed.
//
// The per-domain binding name is derived from mail_domains.name by uppercasing
// and substituting non-alphanumerics with `_`, prefixed with `EMAIL_`. E.g.
// `plrs.im` → `EMAIL_PLRS_IM`. Operators must declare the matching
// `send_email` binding in services/out/wrangler.local.jsonc.
import { ulid } from '@polaris-email/ids';
import type { Env, FanoutEvent, OutboundQueueMessage, SendEmailBinding } from './env.js';

function bindingNameForDomain(name: string): string {
  return 'EMAIL_' + name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

async function loadRawMime(env: Env, key: string): Promise<Uint8Array | null> {
  const obj = await env.R2.get(key);
  if (!obj) return null;
  const buf = await (obj as unknown as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer();
  return new Uint8Array(buf);
}

async function setStatus(
  env: Env,
  id: string,
  status: 'sending' | 'sent' | 'bounced' | 'failed',
  meta: { last_error?: string; bounce_metadata?: string } = {},
): Promise<void> {
  const nowIso = new Date().toISOString();
  const tsCol =
    status === 'sending'
      ? 'sending_at'
      : status === 'sent'
        ? 'sent_at'
        : status === 'failed'
          ? 'failed_at'
          : null;
  if (tsCol) {
    await env.DB.prepare(
      `UPDATE messages SET status = ?, ${tsCol} = ?, last_error = ?, bounce_metadata = ? WHERE id = ?`,
    )
      .bind(status, nowIso, meta.last_error ?? null, meta.bounce_metadata ?? null, id)
      .run();
  } else {
    await env.DB.prepare(
      `UPDATE messages SET status = ?, last_error = ?, bounce_metadata = ? WHERE id = ?`,
    )
      .bind(status, meta.last_error ?? null, meta.bounce_metadata ?? null, id)
      .run();
  }
}

async function fanout(env: Env, ev: FanoutEvent): Promise<void> {
  await env.FANOUT_QUEUE.send(ev);
}

interface DomainRow {
  id: string;
  name: string;
}

export default {
  async queue(batch: MessageBatch<OutboundQueueMessage>, env: Env): Promise<void> {
    for (const m of batch.messages) {
      try {
        await handleOne(env, m.body);
        m.ack();
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('out: error', m.body.messageId, e instanceof Error ? e.message : 'unknown');
        m.retry();
      }
    }
  },
};

async function handleOne(env: Env, msg: OutboundQueueMessage): Promise<void> {
  const raw = await loadRawMime(env, msg.r2KeyOrInline);
  if (!raw) {
    await setStatus(env, msg.messageId, 'failed', { last_error: 'r2_body_missing' });
    return;
  }
  const dom = await env.DB.prepare(`SELECT id, name FROM mail_domains WHERE name = ?`)
    .bind(msg.fromDomain)
    .first<DomainRow>();
  if (!dom) {
    await setStatus(env, msg.messageId, 'failed', { last_error: 'no_domain_row' });
    await fanout(env, {
      event_id: ulid(),
      event: 'message.failed',
      message_id: msg.messageId,
      mailbox_id: msg.mailboxId,
      domain_id: msg.domainId,
      created_at: Date.now(),
      data: { reason: 'no_domain_row', from_domain: msg.fromDomain },
    });
    return;
  }
  const domainId = dom.id;
  const bindingName = bindingNameForDomain(dom.name);

  if (msg.mode === 'test') {
    await setStatus(env, msg.messageId, 'sent');
    await fanout(env, {
      event_id: ulid(),
      event: 'message.sent',
      message_id: msg.messageId,
      mailbox_id: msg.mailboxId,
      domain_id: domainId,
      created_at: Date.now(),
      data: { test: true },
    });
    return;
  }

  const binding = (env as unknown as Record<string, SendEmailBinding | undefined>)[bindingName];
  if (!binding || typeof binding.send !== 'function') {
    await setStatus(env, msg.messageId, 'failed', {
      last_error: `binding ${bindingName} not configured`,
    });
    await fanout(env, {
      event_id: ulid(),
      event: 'message.failed',
      message_id: msg.messageId,
      mailbox_id: msg.mailboxId,
      domain_id: domainId,
      created_at: Date.now(),
      data: { reason: 'no_binding', binding: bindingName },
    });
    return;
  }

  await setStatus(env, msg.messageId, 'sending');
  try {
    const result = await binding.send({
      from: msg.fromAddress,
      to: msg.fromAddress, // recipients are encoded inside the RFC822 envelope
      raw: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
    });
    if (result.permanent_bounces.length) {
      await setStatus(env, msg.messageId, 'bounced', {
        last_error: 'permanent_bounce',
        bounce_metadata: JSON.stringify({ permanent_bounces: result.permanent_bounces }),
      });
      await fanout(env, {
        event_id: ulid(),
        event: 'message.bounced',
        message_id: msg.messageId,
        mailbox_id: msg.mailboxId,
        domain_id: domainId,
        created_at: Date.now(),
        data: { permanent_bounces: result.permanent_bounces },
      });
    } else {
      await setStatus(env, msg.messageId, 'sent');
      await fanout(env, {
        event_id: ulid(),
        event: 'message.sent',
        message_id: msg.messageId,
        mailbox_id: msg.mailboxId,
        domain_id: domainId,
        created_at: Date.now(),
        data: { delivered: result.delivered, queued: result.queued },
      });
    }
  } catch (e) {
    const err = e instanceof Error ? e.message : 'unknown';
    if (msg.retries >= 4) {
      await setStatus(env, msg.messageId, 'failed', { last_error: err.slice(0, 256) });
      await fanout(env, {
        event_id: ulid(),
        event: 'message.failed',
        message_id: msg.messageId,
        mailbox_id: msg.mailboxId,
        domain_id: domainId,
        created_at: Date.now(),
        data: { reason: err.slice(0, 256), retries: msg.retries },
      });
    } else {
      throw e;
    }
  }
}
