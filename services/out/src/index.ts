// polaris-mail-out: queue consumer that drives Cloudflare's send_email bindings.
//
// The queue handler reads canonical MIME bytes from R2 (via messages.r2_key,
// content-addressed), hands them to the per-domain `send_email` binding,
// writes the canonical status to D1 (messages table), and emits a fanout
// event.
//
// The `delivered` transition is the responsibility of the FANOUT_QUEUE
// consumer hosted in services/api (see services/api/src/queue/fanout.ts
// folded in during). That consumer flips messages.status to
// 'delivered' on the last successful webhook delivery. This worker only
// handles received → sending → sent | bounced | failed.
//
// The per-domain binding name is derived from mail_domains.name by
// validating it as an FQDN, then uppercasing and substituting `.` with `_`,
// prefixed with `EMAIL_`. E.g. `plrs.im` → `EMAIL_PLRS_IM`. Operators must
// declare the matching `send_email` binding in services/out/wrangler.local.jsonc.
//
// Idempotency: the consumer is invoked at-least-once. Before calling the
// binding's `send()` we transition the message to `sending`; on retry entry
// we observe any non-`queued` status and ack without resending, so a Worker
// crash mid-send can't double-send. The `sending`-stuck case is detected
// and surfaced as `failed` so an operator can investigate.
import { ulid } from '@polaris-mail/ids';
import { MAX_MESSAGE_SIZE_VERIFIED } from '@polaris-mail/mime';
import { checkRecipientSuppression, checkSenderSuppression } from '@polaris-mail/suppressions/d1';
import { evaluateOutboundPolicy } from './lib/policy-dispatch.js';
import type { Env, FanoutEvent, OutboundQueueMessage, SendEmailBinding } from './env.js';

const MAX_DELIVERY_ATTEMPTS = 5; // matches the Workers Queues default; keep in sync with wrangler

/**
 * Strict FQDN check used to derive a binding identifier. We require:
 *   - 1-253 chars total
 *   - 2+ labels separated by single dots (no leading/trailing dot, no `..`)
 *   - each label 1-63 chars, alphanumeric + `-`, no leading/trailing `-`
 *
 * The previous regex (`replace(/[^A-Z0-9]+/g, '_')`) silently collapsed
 * consecutive separators, so `'sub..domain.com'` mapped to the same binding
 * name as `'sub.domain.com'`. With the explicit validator a malformed
 * domain row fails fast and we emit `message.failed` instead of routing to
 * the wrong tenant binding.
 */
function isValidFqdn(name: string): boolean {
  if (name.length < 1 || name.length > 253) return false;
  if (name.startsWith('.') || name.endsWith('.')) return false;
  if (name.includes('..')) return false;
  const labels = name.split('.');
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (label.length < 1 || label.length > 63) return false;
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)) return false;
  }
  return true;
}

function bindingNameForDomain(name: string): string {
  return 'EMAIL_' + name.toUpperCase().replace(/\./g, '_');
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
  status: 'sending' | 'sent' | 'bounced' | 'failed' | 'held',
  meta: { last_error?: string; bounce_metadata?: string } = {},
  expectedFrom?: ReadonlyArray<'queued' | 'sending' | 'sent'>,
): Promise<{ changed: boolean }> {
  const nowIso = new Date().toISOString();
  const tsCol =
    status === 'sending'
      ? 'sending_at'
      : status === 'sent'
        ? 'sent_at'
        : status === 'bounced'
          ? 'bounced_at'
          : status === 'failed'
            ? 'failed_at'
            : null;
  // CAS predicate: when expectedFrom is set, refuse the write unless the
  // current status is one of the listed values. This prevents a stuck
  // late-success from overwriting an authoritative `failed` (or vice
  // versa). Without it, a binding.send() that completes after the row
  // was marked `failed` could flip the row back to `sent`.
  const casFragment = expectedFrom?.length
    ? ` AND status IN (${expectedFrom.map(() => '?').join(',')})`
    : '';
  const casBinds = expectedFrom ?? [];
  if (tsCol) {
    const r = await env.DB.prepare(
      `UPDATE messages SET status = ?, ${tsCol} = ?, last_error = ?, bounce_metadata = ?
        WHERE id = ?${casFragment}`,
    )
      .bind(status, nowIso, meta.last_error ?? null, meta.bounce_metadata ?? null, id, ...casBinds)
      .run();
    return { changed: (r.meta.changes ?? 0) > 0 };
  }
  const r = await env.DB.prepare(
    `UPDATE messages SET status = ?, last_error = ?, bounce_metadata = ?
      WHERE id = ?${casFragment}`,
  )
    .bind(status, meta.last_error ?? null, meta.bounce_metadata ?? null, id, ...casBinds)
    .run();
  return { changed: (r.meta.changes ?? 0) > 0 };
}

async function fanout(env: Env, ev: FanoutEvent): Promise<void> {
  await env.FANOUT_QUEUE.send(ev);
}

/**
 * Read the message's current status. Used as the idempotency check before
 * `binding.send()`: if the row is no longer `queued`, this delivery has
 * already been (at minimum) attempted. We then ack without re-sending
 * the alternative (a second send_email call to the upstream provider)
 * would deliver the same message twice.
 */
async function loadStatus(env: Env, id: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT status FROM messages WHERE id = ?`)
    .bind(id)
    .first<{ status: string }>();
  return row?.status ?? null;
}

interface DomainRow {
  id: string;
  name: string;
}

export default {
  async queue(batch: MessageBatch<OutboundQueueMessage>, env: Env): Promise<void> {
    for (const m of batch.messages) {
      // CF Workers Queues exposes 1-based attempt counter as `m.attempts`.
      // Older shapes / test stubs may omit it; default to 1 so first-attempt
      // logic still applies.
      const attempts = (m as unknown as { attempts?: number }).attempts ?? 1;
      try {
        await handleOne(env, m.body, attempts);
        m.ack();
      } catch (e) {
        // P0 (#3): handleOne owns its own status writes. If an exception
        // escapes anyway we still need to make sure the message doesn't
        // stay stuck in `sending` forever — flip to `failed` so the row is
        // reconcilable from the panel.
        const err = e instanceof Error ? e.message : 'unknown';
        // eslint-disable-next-line no-console
        console.error('out: error', m.body.messageId, err);
        try {
          const cur = await loadStatus(env, m.body.messageId);
          if (cur === 'sending' || cur === 'queued') {
            await setStatus(env, m.body.messageId, 'failed', {
              last_error: `uncaught: ${err}`.slice(0, 256),
            });
          }
        } catch (statusErr) {
          // eslint-disable-next-line no-console
          console.error(
            'out: failed to recover status for',
            m.body.messageId,
            statusErr instanceof Error ? statusErr.message : 'unknown',
          );
        }
        // Still surface to Workers Queues so the at-least-once retry budget
        // (and DLQ on exhaustion) applies.
        m.retry();
      }
    }
  },
};

async function handleOne(env: Env, msg: OutboundQueueMessage, attempts: number): Promise<void> {
  // Idempotency claim (#4): if the row is no longer `queued`, an earlier
  // attempt already passed `setStatus(sending)`. We don't know whether the
  // upstream `binding.send()` succeeded on that attempt, but we DO know
  // that re-sending would risk a duplicate. Ack without resending; the
  // operator can investigate via the panel using the row's status +
  // last_error.
  const preStatus = await loadStatus(env, msg.messageId);
  if (preStatus && preStatus !== 'queued') {
    // eslint-disable-next-line no-console
    console.warn('out: idempotent skip', msg.messageId, `status=${preStatus} attempts=${attempts}`);
    return;
  }

  const raw = await loadRawMime(env, msg.r2KeyOrInline);
  if (!raw) {
    // P3 (#5): emit message.failed so panel + downstream consumers see the
    // terminal transition; without this only the DB row reflects the
    // failure.
    await setStatus(env, msg.messageId, 'failed', { last_error: 'r2_body_missing' });
    await fanout(env, {
      event_id: ulid(),
      event: 'message.failed',
      message_id: msg.messageId,
      mailbox_id: msg.mailboxId,
      domain_id: msg.domainId,
      created_at: Date.now(),
      data: { reason: 'r2_body_missing', r2_key: msg.r2KeyOrInline },
    });
    return;
  }
  // P3 (#7): validate the FQDN before deriving a binding name.
  // `bindingNameForDomain` would otherwise normalise malformed inputs into a
  // valid-looking binding name and either route to the wrong tenant or
  // miss-bind entirely.
  if (!isValidFqdn(msg.fromDomain)) {
    await setStatus(env, msg.messageId, 'failed', {
      last_error: `invalid_from_domain: ${msg.fromDomain}`.slice(0, 256),
    });
    await fanout(env, {
      event_id: ulid(),
      event: 'message.failed',
      message_id: msg.messageId,
      mailbox_id: msg.mailboxId,
      domain_id: msg.domainId,
      created_at: Date.now(),
      data: { reason: 'invalid_from_domain', from_domain: msg.fromDomain },
    });
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

  // belt-and-suspenders: reject before binding.send to avoid
  // surfacing E_CONTENT_TOO_LARGE from CF after we've already claimed the
  // 'sending' status. The cap matches the API-layer's pre-enqueue check
  // (services/api/src/routes/messages.ts) so a queue message that somehow
  // exceeds the cap (stale enqueue, bug) fails cleanly here with a typed
  // last_error.
  if (raw.byteLength > MAX_MESSAGE_SIZE_VERIFIED) {
    await setStatus(env, msg.messageId, 'failed', {
      last_error: `message_too_large:${raw.byteLength}`,
    });
    await fanout(env, {
      event_id: ulid(),
      event: 'message.failed',
      message_id: msg.messageId,
      mailbox_id: msg.mailboxId,
      domain_id: domainId,
      created_at: Date.now(),
      data: {
        reason: 'message_too_large',
        bytes: raw.byteLength,
        cap: MAX_MESSAGE_SIZE_VERIFIED,
      },
    });
    return;
  }

  // Determine envelope recipients. Prefer the explicit list threaded
  // through the queue body; fall back to fromAddress so older queued
  // messages still get a deliverable shape (this is the bug #1 fix — the
  // previous code passed `to: msg.fromAddress` which mailed back to the
  // sender). The CF binding accepts string or string[] — pass an array
  // when we have multiple recipients so cc/bcc all get delivered.
  const rawRecipients: string[] =
    msg.envelopeTo && msg.envelopeTo.length > 0 ? msg.envelopeTo : [msg.fromAddress];

  // W1 — Suppression enforcement. Two-stage check, sender-first:
  //   1. If the sender (mailbox/domain/sender_address/global) is suppressed,
  //      fail the entire send closed with `message.sender_suppressed`. No
  //      partial delivery — a sender flagged for abuse must not leak any
  //      mail at all until ops clears the suppression.
  //   2. Per recipient, drop suppressed addresses; remaining recipients
  //      proceed. If every recipient is suppressed, treat the message as
  //      bounced (no upstream call at all).
  const enforcementCtx = {
    senderAddress: msg.fromAddress,
    mailboxId: msg.mailboxId,
    domainId: domainId,
  };
  const senderHit = await checkSenderSuppression(
    env.DB as unknown as Parameters<typeof checkSenderSuppression>[0],
    enforcementCtx,
  );
  if (senderHit) {
    await setStatus(env, msg.messageId, 'failed', {
      last_error: `sender_suppressed:${senderHit.reason}`,
      bounce_metadata: JSON.stringify({
        suppressed_sender: {
          suppression_id: senderHit.id,
          reason: senderHit.reason,
          severity: senderHit.severity,
          scope: senderHit.scope,
          scope_target: senderHit.scope_target,
        },
      }),
    });
    await fanout(env, {
      event_id: ulid(),
      event: 'message.sender_suppressed',
      message_id: msg.messageId,
      mailbox_id: msg.mailboxId,
      domain_id: domainId,
      created_at: Date.now(),
      data: {
        suppression_id: senderHit.id,
        reason: senderHit.reason,
        severity: senderHit.severity,
        scope: senderHit.scope,
      },
    });
    return;
  }

  const droppedRecipients: { address: string; reason: string; suppression_id: string }[] = [];
  const survivingRecipients: string[] = [];
  for (const r of rawRecipients) {
    const hit = await checkRecipientSuppression(
      env.DB as unknown as Parameters<typeof checkRecipientSuppression>[0],
      r,
      enforcementCtx,
    );
    if (hit) {
      droppedRecipients.push({ address: r, reason: hit.reason, suppression_id: hit.id });
    } else {
      survivingRecipients.push(r);
    }
  }
  if (droppedRecipients.length > 0) {
    // Emit one fanout event documenting every drop. The panel surfaces this
    // on the message detail page so operators can see why a recipient
    // didn't receive mail.
    await fanout(env, {
      event_id: ulid(),
      event: 'message.suppressed',
      message_id: msg.messageId,
      mailbox_id: msg.mailboxId,
      domain_id: domainId,
      created_at: Date.now(),
      data: { dropped: droppedRecipients, kept: survivingRecipients },
    });
  }
  if (survivingRecipients.length === 0) {
    // All recipients suppressed → terminal `bounced` status. Distinct from a
    // sender suppression because the sender is healthy — only the audience
    // was unreachable. Mirror the same bounce_metadata shape the
    // permanent_bounces path uses so the panel can show one consistent view.
    await setStatus(env, msg.messageId, 'bounced', {
      last_error: 'all_recipients_suppressed',
      bounce_metadata: JSON.stringify({ suppressed_recipients: droppedRecipients }),
    });
    await fanout(env, {
      event_id: ulid(),
      event: 'message.bounced',
      message_id: msg.messageId,
      mailbox_id: msg.mailboxId,
      domain_id: domainId,
      created_at: Date.now(),
      data: { reason: 'all_recipients_suppressed', dropped: droppedRecipients },
    });
    return;
  }
  const envelopeTo: string | string[] =
    survivingRecipients.length === 1 ? survivingRecipients[0]! : survivingRecipients;

  // 0019 — Hybrid Policy Engine. Heuristics-only on outbound (no AI
  // binding wired on services/out — uncertain band goes straight to
  // 'hold'). Block + hold downgrade to pass_warn during the
  // POLICY_ENGINE_OUTBOUND_FULL soak. Runs AFTER W1 so obviously-banned
  // sender/recipient pairs are filtered cheaply before the engine runs.
  const policyAction = await evaluateOutboundPolicy(env, msg, raw, domainId);
  if (policyAction.kind === 'block') {
    await setStatus(env, msg.messageId, 'failed', {
      last_error: `policy_block:${policyAction.decision.total_score}`,
      bounce_metadata: JSON.stringify({
        policy_block: {
          decision_id: policyAction.decision.decision_id,
          score: policyAction.decision.total_score,
          reasons: policyAction.decision.reasons,
        },
      }),
    });
    await fanout(env, {
      event_id: ulid(),
      event: 'message.bounced',
      message_id: msg.messageId,
      mailbox_id: msg.mailboxId,
      domain_id: domainId,
      created_at: Date.now(),
      data: {
        reason: 'policy_block',
        decision_id: policyAction.decision.decision_id,
        score: policyAction.decision.total_score,
        top_reasons: policyAction.decision.reasons.slice(0, 5),
      },
    });
    return;
  }
  if (policyAction.kind === 'hold') {
    await setStatus(env, msg.messageId, 'held', {
      last_error: `policy_hold:${policyAction.decision.total_score}`,
      bounce_metadata: JSON.stringify({
        policy_hold: {
          decision_id: policyAction.decision.decision_id,
          hold_id: policyAction.hold_id,
          score: policyAction.decision.total_score,
          reasons: policyAction.decision.reasons,
        },
      }),
    });
    // Note: no fanout event for hold yet — the moderation queue UI in
    // P4 surfaces these. A `message.held` fanout event could be added
    // later if callers want webhook notification on hold.
    return;
  }

  // Mark sending BEFORE the binding.send() call. Combined with the
  // idempotency check at the top of handleOne, this serves as the
  // in-flight claim: a second invocation will see status != 'queued' and
  // skip re-sending. CAS on `queued` so we don't overwrite an already-
  // terminal state (failed/bounced) that won a concurrent race.
  const enter = await setStatus(env, msg.messageId, 'sending', {}, ['queued', 'sending']);
  if (!enter.changed) return;
  try {
    const result = await binding.send({
      from: msg.fromAddress,
      to: envelopeTo,
      raw: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
    });
    if (result.permanent_bounces.length) {
      const flipped = await setStatus(
        env,
        msg.messageId,
        'bounced',
        {
          last_error: 'permanent_bounce',
          bounce_metadata: JSON.stringify({ permanent_bounces: result.permanent_bounces }),
        },
        ['sending'],
      );
      if (!flipped.changed) return;
      env.ANALYTICS?.writeDataPoint({
        indexes: [msg.fromDomain],
        blobs: ['bounced'],
        doubles: [1],
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
      const flipped = await setStatus(env, msg.messageId, 'sent', {}, ['sending']);
      if (!flipped.changed) return;
      env.ANALYTICS?.writeDataPoint({
        indexes: [msg.fromDomain],
        blobs: ['sent'],
        doubles: [1],
      });
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
    // P0 (#2): rely on CF Workers Queues' native attempt counter rather
    // than trusting the queue body. After MAX_DELIVERY_ATTEMPTS we mark
    // the message as failed and emit message.failed; otherwise we throw
    // and let Workers Queues retry per its configured backoff.
    if (attempts >= MAX_DELIVERY_ATTEMPTS) {
      await setStatus(env, msg.messageId, 'failed', { last_error: err.slice(0, 256) });
      await fanout(env, {
        event_id: ulid(),
        event: 'message.failed',
        message_id: msg.messageId,
        mailbox_id: msg.mailboxId,
        domain_id: domainId,
        created_at: Date.now(),
        data: { reason: err.slice(0, 256), attempts },
      });
    } else {
      throw e;
    }
  }
}
