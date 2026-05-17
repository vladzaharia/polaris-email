// Admin mailbox CRUD endpoints.
//
// Mailbox is the first-class organizing entity in the mailbox-centric schema:
// senders, receivers, principals, and webhook_subs all hang off a mailbox.
// This file covers mailbox lifecycle plus the nested sender / receiver CRUD.
import { Hono } from 'hono';
import {
  CreateMailboxRequest,
  CreateMailboxReceiverRequest,
  CreateMailboxSenderRequest,
  MailboxReceiverAction,
} from '@polaris-email/schema';
import { actorOf, audit } from '../../audit.js';
import { bodyText, requireScope } from '../../auth.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';
import { ulid } from '@polaris-email/ids';

export const mailboxes = new Hono<{ Bindings: Env }>();

// ---------- list (uses v_mailbox_summary view) ----------
// Sentinel mailboxes (name prefix `_polaris_`) are operator-system
// internals (created by migration 0024 to anchor operator principals);
// they have no user-facing meaning and are filtered out of list responses.
mailboxes.get('/v1/admin/mailboxes', requireScope('admin:read'), async (c) => {
  // Production hits the `v_mailbox_summary` view (active sender/receiver
  // counts); degraded environments (in-memory mock D1) fall back to the raw
  // mailboxes table when the view returns no rows.
  let rows = await c.env.DB.prepare(
    `SELECT id, name, description, default_sender_id, created_at, updated_at,
            disabled_at, active_sender_count, active_receiver_count
     FROM v_mailbox_summary WHERE name NOT LIKE '\\_polaris\\_%' ESCAPE '\\'
     ORDER BY name ASC`,
  )
    .all()
    .catch(() => ({ results: [] as unknown[] }));
  if (!rows.results || rows.results.length === 0) {
    rows = await c.env.DB.prepare(
      `SELECT id, name, description, default_sender_id, created_at, updated_at, disabled_at
       FROM mailboxes WHERE name NOT LIKE '\\_polaris\\_%' ESCAPE '\\'
       ORDER BY name ASC`,
    ).all();
  }
  return c.json({ data: rows.results });
});

// ---------- get one (with nested lists) ----------
mailboxes.get('/v1/admin/mailboxes/:id', requireScope('admin:read'), async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT id, name, description, default_sender_id, created_at, updated_at, disabled_at
     FROM mailboxes WHERE id = ?`,
  )
    .bind(id)
    .first();
  if (!row) return buildError(c, 'not_found', 'mailbox not found');
  const senders = await c.env.DB.prepare(
    `SELECT id, mailbox_id, domain_id, address, local_part, display_name,
            default_for_mailbox, created_at, disabled_at
     FROM mailbox_senders WHERE mailbox_id = ? ORDER BY address ASC`,
  )
    .bind(id)
    .all();
  const receivers = await c.env.DB.prepare(
    `SELECT id, mailbox_id, domain_id, priority, address_pattern, action,
            webhook_sub_id, forward_to, enabled, created_at, disabled_at
     FROM mailbox_receivers WHERE mailbox_id = ? ORDER BY priority ASC`,
  )
    .bind(id)
    .all();
  const principals = await c.env.DB.prepare(
    `SELECT id, mailbox_id, kind, display_name, created_at, disabled_at
     FROM principals WHERE mailbox_id = ?`,
  )
    .bind(id)
    .all();
  const webhookSubs = await c.env.DB.prepare(
    `SELECT id, mailbox_id, url, kind, events, paused_at, created_at, disabled_at
     FROM webhook_subs WHERE mailbox_id = ?`,
  )
    .bind(id)
    .all();
  return c.json({
    mailbox: row,
    senders: senders.results,
    receivers: receivers.results,
    principals: principals.results,
    webhook_subs: webhookSubs.results,
  });
});

// ---------- create mailbox ----------
mailboxes.post('/v1/admin/mailboxes', requireScope('admin:rotate'), async (c) => {
  let body;
  try {
    body = CreateMailboxRequest.parse(JSON.parse(bodyText(c)));
  } catch (e) {
    return buildError(c, 'bad_request', e instanceof Error ? e.message : 'invalid body');
  }
  const id = ulid();
  const nowIso = new Date().toISOString();
  try {
    await c.env.DB.prepare(
      `INSERT INTO mailboxes (id, name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(id, body.name, body.description ?? null, nowIso, nowIso)
      .run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) return buildError(c, 'conflict', 'mailbox name taken');
    throw e;
  }
  await audit(c.env, {
    actor: actorOf(c),
    action: 'mailbox.create',
    target: id,
    meta: { name: body.name },
  });
  return c.json({ id, name: body.name, created_at: Date.now() }, 201);
});

// ---------- patch (name/description/default_sender_id) ----------
mailboxes.patch('/v1/admin/mailboxes/:id', requireScope('admin:rotate'), async (c) => {
  const id = c.req.param('id');
  let body: { name?: string; description?: string | null; default_sender_id?: string | null };
  try {
    body = JSON.parse(bodyText(c) || '{}');
  } catch {
    return buildError(c, 'bad_request', 'invalid json');
  }
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.name !== undefined) {
    sets.push('name = ?');
    binds.push(body.name);
  }
  if (body.description !== undefined) {
    sets.push('description = ?');
    binds.push(body.description);
  }
  if (body.default_sender_id !== undefined) {
    sets.push('default_sender_id = ?');
    binds.push(body.default_sender_id);
  }
  if (sets.length === 0) return buildError(c, 'bad_request', 'no fields to update');
  const nowIso = new Date().toISOString();
  sets.push('updated_at = ?');
  binds.push(nowIso);
  binds.push(id);
  const r = await c.env.DB.prepare(`UPDATE mailboxes SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds)
    .run();
  if (r.meta.changes === 0) return buildError(c, 'not_found', 'mailbox not found');
  await audit(c.env, {
    actor: actorOf(c),
    action: 'mailbox.update',
    target: id,
    meta: { fields: Object.keys(body) },
  });
  return c.json({ id, updated_at: Date.now() });
});

// ---------- disable / enable ----------
mailboxes.post('/v1/admin/mailboxes/:id/disable', requireScope('admin:rotate'), async (c) => {
  const id = c.req.param('id');
  const nowIso = new Date().toISOString();
  const r = await c.env.DB.prepare(
    `UPDATE mailboxes SET disabled_at = ?, updated_at = ? WHERE id = ? AND disabled_at IS NULL`,
  )
    .bind(nowIso, nowIso, id)
    .run();
  if (r.meta.changes === 0) return buildError(c, 'not_found', 'not found or already disabled');
  await audit(c.env, {
    actor: actorOf(c),
    action: 'mailbox.disable',
    target: id,
    meta: {},
  });
  return c.json({ id, disabled_at: Date.now() });
});

mailboxes.post('/v1/admin/mailboxes/:id/enable', requireScope('admin:rotate'), async (c) => {
  const id = c.req.param('id');
  const nowIso = new Date().toISOString();
  const r = await c.env.DB.prepare(
    `UPDATE mailboxes SET disabled_at = NULL, updated_at = ? WHERE id = ? AND disabled_at IS NOT NULL`,
  )
    .bind(nowIso, id)
    .run();
  if (r.meta.changes === 0) return buildError(c, 'not_found', 'not found or already enabled');
  await audit(c.env, {
    actor: actorOf(c),
    action: 'mailbox.update',
    target: id,
    meta: { enable: true },
  });
  return c.json({ id, enabled_at: Date.now() });
});

// ---------- create mailbox_sender ----------
mailboxes.post('/v1/admin/mailboxes/:id/senders', requireScope('admin:rotate'), async (c) => {
  const mailboxId = c.req.param('id');
  let body;
  try {
    body = CreateMailboxSenderRequest.parse(JSON.parse(bodyText(c)));
  } catch (e) {
    return buildError(c, 'bad_request', e instanceof Error ? e.message : 'invalid body');
  }
  if (!body.domain_id) {
    return buildError(c, 'bad_request', 'domain_id required');
  }
  // Resolve the domain to compose the full address.
  const dom = await c.env.DB.prepare(`SELECT id, name FROM mail_domains WHERE id = ?`)
    .bind(body.domain_id)
    .first<{ id: string; name: string }>();
  if (!dom) return buildError(c, 'not_found', 'mail_domain not found');

  const id = ulid();
  const nowIso = new Date().toISOString();
  const address = `${body.local_part}@${dom.name}`;
  const isDefault = body.default_for_mailbox ? 1 : 0;
  try {
    if (isDefault === 1) {
      await c.env.DB.prepare(
        `UPDATE mailbox_senders SET default_for_mailbox = 0
         WHERE mailbox_id = ? AND default_for_mailbox = 1`,
      )
        .bind(mailboxId)
        .run();
    }
    await c.env.DB.prepare(
      `INSERT INTO mailbox_senders
         (id, mailbox_id, domain_id, address, local_part, display_name,
          default_for_mailbox, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        mailboxId,
        body.domain_id,
        address,
        body.local_part,
        body.display_name ?? null,
        isDefault,
        nowIso,
      )
      .run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) return buildError(c, 'conflict', 'address already in use');
    throw e;
  }
  await audit(c.env, {
    actor: actorOf(c),
    action: 'mailbox_sender.create',
    target: id,
    meta: { mailbox_id: mailboxId, domain_id: body.domain_id, address },
  });
  return c.json(
    {
      id,
      mailbox_id: mailboxId,
      domain_id: body.domain_id,
      address,
      local_part: body.local_part,
      display_name: body.display_name ?? null,
      default_for_mailbox: isDefault,
      created_at: Date.now(),
    },
    201,
  );
});

// ---------- soft-disable mailbox_sender ----------
mailboxes.delete(
  '/v1/admin/mailboxes/:id/senders/:senderId',
  requireScope('admin:rotate'),
  async (c) => {
    const senderId = c.req.param('senderId');
    const nowIso = new Date().toISOString();
    const r = await c.env.DB.prepare(
      `UPDATE mailbox_senders SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL`,
    )
      .bind(nowIso, senderId)
      .run();
    if (r.meta.changes === 0) return buildError(c, 'not_found', 'not found or already disabled');
    await audit(c.env, {
      actor: actorOf(c),
      action: 'mailbox_sender.disable',
      target: senderId,
      meta: { mailbox_id: c.req.param('id') },
    });
    return c.json({ id: senderId, disabled_at: Date.now() });
  },
);

// ---------- create mailbox_receiver ----------
mailboxes.post('/v1/admin/mailboxes/:id/receivers', requireScope('admin:rotate'), async (c) => {
  const mailboxId = c.req.param('id');
  let body;
  try {
    // The schema's mailbox_id is taken from the URL path; fold it in before parse.
    const raw = JSON.parse(bodyText(c) || '{}');
    raw.mailbox_id = mailboxId;
    body = CreateMailboxReceiverRequest.parse(raw);
  } catch (e) {
    return buildError(c, 'bad_request', e instanceof Error ? e.message : 'invalid body');
  }
  const id = ulid();
  const nowIso = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO mailbox_receivers
         (id, mailbox_id, domain_id, priority, address_pattern, action,
          webhook_sub_id, forward_to, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  )
    .bind(
      id,
      mailboxId,
      body.domain_id,
      body.priority,
      body.address_pattern,
      body.action,
      body.webhook_sub_id ?? null,
      body.forward_to ?? null,
      nowIso,
    )
    .run();
  await audit(c.env, {
    actor: actorOf(c),
    action: 'mailbox_receiver.create',
    target: id,
    meta: {
      mailbox_id: mailboxId,
      domain_id: body.domain_id,
      priority: body.priority,
      action: body.action,
    },
  });
  return c.json({ id }, 201);
});

// ---------- patch mailbox_receiver (toggle enabled/pattern/action) ----------
mailboxes.patch(
  '/v1/admin/mailboxes/:id/receivers/:receiverId',
  requireScope('admin:rotate'),
  async (c) => {
    const mailboxId = c.req.param('id');
    const receiverId = c.req.param('receiverId');
    let body: {
      priority?: number;
      address_pattern?: string;
      action?: string;
      webhook_sub_id?: string | null;
      forward_to?: string | null;
      enabled?: boolean;
    };
    try {
      body = JSON.parse(bodyText(c) || '{}');
    } catch {
      return buildError(c, 'bad_request', 'invalid json');
    }
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (body.priority !== undefined) {
      sets.push('priority = ?');
      binds.push(body.priority);
    }
    if (body.address_pattern !== undefined) {
      sets.push('address_pattern = ?');
      binds.push(body.address_pattern);
    }
    if (body.action !== undefined) {
      const parsed = MailboxReceiverAction.safeParse(body.action);
      if (!parsed.success) return buildError(c, 'bad_request', 'invalid action');
      sets.push('action = ?');
      binds.push(parsed.data);
    }
    if (body.webhook_sub_id !== undefined) {
      sets.push('webhook_sub_id = ?');
      binds.push(body.webhook_sub_id);
    }
    if (body.forward_to !== undefined) {
      sets.push('forward_to = ?');
      binds.push(body.forward_to);
    }
    if (body.enabled !== undefined) {
      sets.push('enabled = ?');
      binds.push(body.enabled ? 1 : 0);
    }
    if (sets.length === 0) return buildError(c, 'bad_request', 'no fields to update');
    binds.push(receiverId);
    const r = await c.env.DB.prepare(`UPDATE mailbox_receivers SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...binds)
      .run();
    if (r.meta.changes === 0) return buildError(c, 'not_found', 'mailbox_receiver not found');
    await audit(c.env, {
      actor: actorOf(c),
      action: 'mailbox_receiver.update',
      target: receiverId,
      meta: { mailbox_id: mailboxId, fields: Object.keys(body) },
    });
    return c.json({ id: receiverId });
  },
);

// ---------- soft-disable mailbox_receiver ----------
mailboxes.delete(
  '/v1/admin/mailboxes/:id/receivers/:receiverId',
  requireScope('admin:rotate'),
  async (c) => {
    const mailboxId = c.req.param('id');
    const receiverId = c.req.param('receiverId');
    const nowIso = new Date().toISOString();
    const r = await c.env.DB.prepare(
      `UPDATE mailbox_receivers SET disabled_at = ?, enabled = 0
       WHERE id = ? AND disabled_at IS NULL`,
    )
      .bind(nowIso, receiverId)
      .run();
    if (r.meta.changes === 0) return buildError(c, 'not_found', 'not found or already disabled');
    await audit(c.env, {
      actor: actorOf(c),
      action: 'mailbox_receiver.disable',
      target: receiverId,
      meta: { mailbox_id: mailboxId },
    });
    return c.json({ id: receiverId, disabled_at: Date.now() });
  },
);
