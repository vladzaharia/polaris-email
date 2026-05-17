// Admin webhook subscription CRUD list / detail / patch / delete / test.
//
// The POST /v1/admin/webhook-subs creator already lives in routes/admin.ts; we
// add list/detail/patch/delete/test here so the panel can manage existing
// rows. All routes are admin:* scoped (parent middleware handles HMAC).
import { Hono } from 'hono';
import { audit } from '../../audit.js';
import { bodyText, requireScope } from '../../auth.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';
import { validateWebhookUrl, type WebhookKind } from '../../lib/webhook-url.js';

export const webhookSubs = new Hono<{ Bindings: Env }>();

interface WebhookSubRow {
  id: string;
  mailbox_id: string;
  url: string;
  kind: string;
  events: string;
  paused_at: string | null;
  created_at: string;
  disabled_at: string | null;
}

webhookSubs.get('/v1/admin/webhook-subs', requireScope('admin:read'), async (c) => {
  const mailboxId = c.req.query('mailbox_id');
  const rows = mailboxId
    ? await c.env.DB.prepare(
        `SELECT id, mailbox_id, url, kind, events, paused_at, created_at, disabled_at
         FROM webhook_subs WHERE mailbox_id = ?
         ORDER BY created_at DESC`,
      )
        .bind(mailboxId)
        .all<WebhookSubRow>()
    : await c.env.DB.prepare(
        `SELECT id, mailbox_id, url, kind, events, paused_at, created_at, disabled_at
         FROM webhook_subs ORDER BY created_at DESC LIMIT 500`,
      ).all<WebhookSubRow>();
  return c.json({ data: rows.results });
});

webhookSubs.get('/v1/admin/webhook-subs/:id', requireScope('admin:read'), async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT id, mailbox_id, url, kind, events, paused_at, created_at, disabled_at
     FROM webhook_subs WHERE id = ?`,
  )
    .bind(id)
    .first<WebhookSubRow>();
  if (!row) return buildError(c, 'not_found', 'webhook subscription not found');
  return c.json(row);
});

webhookSubs.patch('/v1/admin/webhook-subs/:id', requireScope('admin:rotate'), async (c) => {
  const key = c.get('apiKey');
  const id = c.req.param('id');
  let body: { url?: string; events?: string[]; paused?: boolean };
  try {
    body = JSON.parse(bodyText(c) || '{}');
  } catch {
    return buildError(c, 'bad_request', 'invalid json');
  }
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.url !== undefined) {
    // PATCH must re-run the same SSRF allowlist that POST applied at create
    // time. Without this, a row created with a benign URL could be flipped to
    // an http:// or non-.ts.net target via PATCH and would then bypass the
    // create-time gate entirely. The runtime `safeFetch` defence catches the
    // worst cases at fanout time, but failing fast at admin write time keeps
    // misconfigured rows from ever reaching the queue.
    const existing = await c.env.DB.prepare(`SELECT kind FROM webhook_subs WHERE id = ?`)
      .bind(id)
      .first<{ kind: string }>();
    if (!existing) return buildError(c, 'not_found', 'webhook_sub not found');
    const kind = existing.kind as WebhookKind;
    const urlErr = validateWebhookUrl(body.url, kind);
    if (urlErr) return buildError(c, 'bad_request', urlErr);
    sets.push('url = ?');
    binds.push(body.url);
  }
  if (body.events !== undefined) {
    sets.push('events = ?');
    binds.push(JSON.stringify(body.events));
  }
  if (body.paused !== undefined) {
    sets.push('paused_at = ?');
    binds.push(body.paused ? new Date().toISOString() : null);
  }
  if (sets.length === 0) return buildError(c, 'bad_request', 'no fields to update');
  binds.push(id);
  const r = await c.env.DB.prepare(`UPDATE webhook_subs SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds)
    .run();
  if (r.meta.changes === 0) return buildError(c, 'not_found', 'webhook_sub not found');
  await audit(c.env, {
    actor: `key:${key.key_id}`,
    action: 'webhook_sub.update',
    target: id,
    meta: { fields: Object.keys(body) },
  });
  return c.json({ id, updated_at: Date.now() });
});

// Rotate the signing secret. The previous secret moves to `secret_prev`
// so subscribers within the grace window can verify against either key
// during their own rotation. A subsequent rotation overwrites
// `secret_prev` — there is no permanent multi-secret state.
webhookSubs.post(
  '/v1/admin/webhook-subs/:id/rotate-secret',
  requireScope('admin:rotate'),
  async (c) => {
    const key = c.get('apiKey');
    const id = c.req.param('id');
    const buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    const newSecret = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
    const nowIso = new Date().toISOString();
    const r = await c.env.DB.prepare(
      `UPDATE webhook_subs
        SET secret_prev = secret,
            secret = ?,
            secret_rotated_at = ?
      WHERE id = ? AND disabled_at IS NULL`,
    )
      .bind(newSecret, nowIso, id)
      .run();
    if (r.meta.changes === 0) return buildError(c, 'not_found', 'not found or disabled');
    await audit(c.env, {
      actor: `key:${key.key_id}`,
      action: 'webhook_sub.rotate',
      target: id,
      meta: { rotated_at: nowIso },
    });
    return c.json({ id, secret: newSecret, rotated_at: nowIso });
  },
);

webhookSubs.delete('/v1/admin/webhook-subs/:id', requireScope('admin:rotate'), async (c) => {
  const key = c.get('apiKey');
  const id = c.req.param('id');
  const nowIso = new Date().toISOString();
  const r = await c.env.DB.prepare(
    `UPDATE webhook_subs SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL`,
  )
    .bind(nowIso, id)
    .run();
  if (r.meta.changes === 0) return buildError(c, 'not_found', 'not found or already disabled');
  await audit(c.env, {
    actor: `key:${key.key_id}`,
    action: 'webhook_sub.delete',
    target: id,
    meta: {},
  });
  return c.json({ id, disabled_at: Date.now() });
});

// Synthetic test: records an audit row tagged as a panel-initiated test;
// the FANOUT_QUEUE consumer (services/api/src/queue/fanout.ts, folded in
// during) pollutes this branch with a real fire-and-forget delivery
// once it's wired against the same row. The panel uses this as a green/red
// indicator that the row is reachable from the admin plane.
webhookSubs.post('/v1/admin/webhook-subs/:id/test', requireScope('admin:rotate'), async (c) => {
  const key = c.get('apiKey');
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(`SELECT id, url FROM webhook_subs WHERE id = ?`)
    .bind(id)
    .first<{ id: string; url: string }>();
  if (!row) return buildError(c, 'not_found', 'webhook_sub not found');
  await audit(c.env, {
    actor: `key:${key.key_id}`,
    action: 'webhook_sub.test',
    target: id,
    meta: { url_host: new URL(row.url).hostname },
  });
  return c.json({ id, tested_at: Date.now(), note: 'test event audited' });
});
