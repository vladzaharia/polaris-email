// Admin webhook DLQ routes. The FANOUT_QUEUE consumer (see
// services/api/src/queue/fanout.ts) writes a row here on terminal webhook
// delivery failure; operators replay or drop them.
import { Hono } from 'hono';
import { audit } from '../../audit.js';
import { requireScope } from '../../auth.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';

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
  const nowIso = new Date().toISOString();
  const r = await c.env.DB.prepare(
    `UPDATE webhook_dlq SET replayed_at = ?
     WHERE id = ? AND replayed_at IS NULL AND dropped_at IS NULL`,
  )
    .bind(nowIso, id)
    .run();
  if (r.meta.changes === 0) return buildError(c, 'not_found', 'not found or already settled');
  await audit(c.env, {
    actor: `key:${key.key_id}`,
    action: 'webhook_sub.replay',
    target: id,
    meta: {},
  });
  return c.json({ id, replayed_at: Date.now() });
});

webhookDlq.post('/v1/admin/webhook-dlq/:id/drop', requireScope('admin:rotate'), async (c) => {
  const key = c.get('apiKey');
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
    actor: `key:${key.key_id}`,
    action: 'webhook_sub.delete',
    target: id,
    meta: { via: 'dlq_drop' },
  });
  return c.json({ id, dropped_at: Date.now() });
});
