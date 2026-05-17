// Admin webhook DLQ routes. The FANOUT_QUEUE consumer (see
// services/api/src/queue/fanout.ts) writes a row here on terminal webhook
// delivery failure; operators replay or drop them.
import { Hono } from 'hono';
import { ulid } from '@polaris-email/ids';
import { actorOf, audit } from '../../audit.js';
import { requireScope } from '../../auth.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';
import type { FanoutEvent } from '../../queue/fanout.js';
import { adminRateLimit } from '../../rate-limit.js';

type Direction = 'in' | 'out';
type MessageStatus = 'received' | 'sent' | 'delivered' | 'bounced' | 'failed';

function replayEventName(direction: Direction, status: MessageStatus): FanoutEvent['event'] {
  if (direction === 'in') return 'message.received';
  if (status === 'delivered') return 'message.delivered';
  if (status === 'bounced') return 'message.bounced';
  if (status === 'failed') return 'message.failed';
  return 'message.sent';
}

export const webhookDlq = new Hono<{ Bindings: Env }>();

interface DlqRow {
  id: string;
  message_id: string | null;
  webhook_sub_id: string;
  payload_sha256: string;
  last_status_code: number | null;
  last_error: string | null;
  attempts: number;
  dlq_at: string;
  replayed_at: string | null;
  dropped_at: string | null;
}

webhookDlq.get('/v1/admin/webhook-dlq', requireScope('admin:read'), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, message_id, webhook_sub_id, payload_sha256, last_status_code,
            last_error, attempts, dlq_at, replayed_at, dropped_at
     FROM webhook_dlq
     WHERE dropped_at IS NULL AND replayed_at IS NULL
     ORDER BY dlq_at DESC LIMIT 200`,
  ).all<DlqRow>();
  return c.json({ data: rows.results });
});

webhookDlq.get('/v1/admin/webhook-dlq/:id', requireScope('admin:read'), async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT id, message_id, webhook_sub_id, payload_sha256, last_status_code,
            last_error, attempts, dlq_at, replayed_at, dropped_at
     FROM webhook_dlq WHERE id = ?`,
  )
    .bind(id)
    .first<DlqRow>();
  if (!row) return buildError(c, 'not_found', 'dlq row not found');
  return c.json(row);
});

webhookDlq.post('/v1/admin/webhook-dlq/:id/replay', requireScope('admin:rotate'), async (c) => {
  const key = c.get('apiKey');
  const id = c.req.param('id');
  const limit = await adminRateLimit(c.env, key.key_id);
  if (!limit.ok) {
    return buildError(c, 'rate_limited', 'too many replay calls', {
      'retry-after': String(limit.retryAfterSec),
    });
  }
  const dlqRow = await c.env.DB.prepare(
    `SELECT id, message_id, webhook_sub_id, replayed_at, dropped_at
     FROM webhook_dlq WHERE id = ?`,
  )
    .bind(id)
    .first<{
      id: string;
      message_id: string | null;
      webhook_sub_id: string;
      replayed_at: string | null;
      dropped_at: string | null;
    }>();
  if (!dlqRow) return buildError(c, 'not_found', 'dlq row not found');
  if (dlqRow.replayed_at || dlqRow.dropped_at) {
    return buildError(c, 'conflict', 'already settled');
  }
  if (!dlqRow.message_id) {
    return buildError(c, 'not_found', 'message has been retention-pruned; cannot replay');
  }
  const msg = await c.env.DB.prepare(
    `SELECT id, mailbox_id, direction, status FROM messages WHERE id = ?`,
  )
    .bind(dlqRow.message_id)
    .first<{ id: string; mailbox_id: string; direction: Direction; status: MessageStatus }>();
  if (!msg) return buildError(c, 'not_found', 'message row missing; cannot replay');

  const event: FanoutEvent = {
    event_id: ulid(),
    event: replayEventName(msg.direction, msg.status),
    message_id: msg.id,
    mailbox_id: msg.mailbox_id,
    webhook_sub_id: dlqRow.webhook_sub_id,
    created_at: Date.now(),
  };

  await c.env.FANOUT_QUEUE.send(event);

  const nowIso = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE webhook_dlq SET replayed_at = ?
     WHERE id = ? AND replayed_at IS NULL AND dropped_at IS NULL`,
  )
    .bind(nowIso, id)
    .run();
  await audit(c.env, {
    actor: actorOf(c),
    action: 'webhook_sub.replay',
    target: id,
    meta: { event_id: event.event_id, webhook_sub_id: dlqRow.webhook_sub_id },
  });
  return c.json({ id, replayed_at: Date.now(), event_id: event.event_id });
});

webhookDlq.post('/v1/admin/webhook-dlq/:id/drop', requireScope('admin:rotate'), async (c) => {
  const id = c.req.param('id');
  const nowIso = new Date().toISOString();
  const r = await c.env.DB.prepare(
    `UPDATE webhook_dlq SET dropped_at = ?
     WHERE id = ? AND replayed_at IS NULL AND dropped_at IS NULL`,
  )
    .bind(nowIso, id)
    .run();
  if (r.meta.changes === 0) return buildError(c, 'not_found', 'not found or already settled');
  await audit(c.env, {
    actor: actorOf(c),
    action: 'webhook_sub.delete',
    target: id,
    meta: { via: 'dlq_drop' },
  });
  return c.json({ id, dropped_at: Date.now() });
});
