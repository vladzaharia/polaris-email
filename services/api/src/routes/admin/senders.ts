// Admin REST routes for email_senders and smtp_credentials.
// All HMAC-signed (admin middleware applied at the parent `admin` Hono instance).
import { Hono } from 'hono';
import {
  CreateEmailSenderRequest,
  CreateSmtpCredentialRequest,
} from '@polaris-email/schema';
import { generateSecret } from '@polaris-email/hmac';
import { audit } from '../../audit.js';
import { bodyText, requireScope } from '../../auth.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';
import { hashSecret } from '../../hashing.js';
import { ulid } from '../../ids.js';

export const senders = new Hono<{ Bindings: Env }>();

interface SenderRow {
  id: string;
  domain_id: string;
  local_part: string;
  display_name: string | null;
  default_for_domain: number;
  created_at: number;
  disabled_at: number | null;
}

// ---------- create sender under a domain ----------
senders.post(
  '/v1/admin/outbound-domains/:domainId/senders',
  requireScope('admin:rotate'),
  async (c) => {
    const key = c.get('apiKey');
    const domainId = c.req.param('domainId');
    let body;
    try {
      body = CreateEmailSenderRequest.parse(JSON.parse(bodyText(c)));
    } catch (e) {
      return buildError(c, 'bad_request', e instanceof Error ? e.message : 'invalid body');
    }
    const dom = await c.env.DB.prepare(
      `SELECT id, domain FROM outbound_domains WHERE id = ?`,
    )
      .bind(domainId)
      .first<{ id: string; domain: string }>();
    if (!dom) return buildError(c, 'not_found', 'outbound_domain not found');
    const id = ulid();
    const now = Date.now();
    const isDefault = body.default_for_domain ? 1 : 0;
    try {
      if (isDefault === 1) {
        await c.env.DB.prepare(
          `UPDATE email_senders SET default_for_domain = 0 WHERE domain_id = ? AND default_for_domain = 1`,
        )
          .bind(domainId)
          .run();
      }
      await c.env.DB.prepare(
        `INSERT INTO email_senders (id, domain_id, local_part, display_name, default_for_domain, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(id, domainId, body.local_part, body.display_name ?? null, isDefault, now)
        .run();
    } catch (e) {
      if (String(e).includes('UNIQUE'))
        return buildError(c, 'conflict', 'local_part already in use for this domain');
      throw e;
    }
    await audit(c.env, {
      actor: `key:${key.key_id}`,
      action: 'email_sender.create',
      target: id,
      meta: { domain_id: domainId, local_part: body.local_part, default: isDefault === 1 },
    });
    return c.json(
      {
        id,
        address: `${body.local_part}@${dom.domain}`,
        domain_id: domainId,
        default_for_domain: isDefault === 1,
        created_at: now,
      },
      201,
    );
  },
);

// ---------- list senders under a domain ----------
senders.get(
  '/v1/admin/outbound-domains/:domainId/senders',
  requireScope('admin:read'),
  async (c) => {
    const domainId = c.req.param('domainId');
    const rows = await c.env.DB.prepare(
      `SELECT id, domain_id, local_part, display_name, default_for_domain, created_at, disabled_at
       FROM email_senders WHERE domain_id = ? ORDER BY default_for_domain DESC, local_part ASC`,
    )
      .bind(domainId)
      .all<SenderRow>();
    return c.json({ data: rows.results });
  },
);

// ---------- soft-disable sender ----------
senders.delete('/v1/admin/senders/:id', requireScope('admin:rotate'), async (c) => {
  const key = c.get('apiKey');
  const id = c.req.param('id');
  const now = Date.now();
  // Resolve the sender's full address up-front so we can enqueue a Mox
  // remove_account op alongside the soft-disable update.
  const senderRow = await c.env.DB.prepare(
    `SELECT id, domain_id, local_part, disabled_at FROM email_senders WHERE id = ?`,
  )
    .bind(id)
    .first<{ id: string; domain_id: string; local_part: string; disabled_at: number | null }>();
  if (!senderRow || senderRow.disabled_at != null) {
    return buildError(c, 'not_found', 'not found or already disabled');
  }
  const domRow = await c.env.DB.prepare(
    `SELECT domain FROM outbound_domains WHERE id = ?`,
  )
    .bind(senderRow.domain_id)
    .first<{ domain: string }>();
  const username = domRow ? `${senderRow.local_part}@${domRow.domain}` : null;
  const opId = ulid();
  const ops = [
    c.env.DB.prepare(
      `UPDATE email_senders SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL`,
    ).bind(now, id),
  ];
  if (username) {
    ops.push(
      c.env.DB.prepare(
        `INSERT INTO mox_pending_ops (id, op, username, payload_b64, created_at)
         VALUES (?, ?, ?, NULL, ?)`,
      ).bind(opId, 'remove_account', username, now),
    );
  }
  const results = await c.env.DB.batch(ops);
  if (results[0]?.meta?.changes === 0) {
    return buildError(c, 'not_found', 'not found or already disabled');
  }
  await audit(c.env, {
    actor: `key:${key.key_id}`,
    action: 'email_sender.disable',
    target: id,
    meta: {},
  });
  return c.json({ id, disabled_at: now });
});

// ---------- issue SMTP credential ----------
senders.post(
  '/v1/admin/senders/:id/smtp-credentials',
  requireScope('admin:rotate'),
  async (c) => {
    const key = c.get('apiKey');
    const senderId = c.req.param('id');
    let body;
    try {
      body = CreateSmtpCredentialRequest.parse(JSON.parse(bodyText(c) || '{}'));
    } catch (e) {
      return buildError(c, 'bad_request', e instanceof Error ? e.message : 'invalid body');
    }
    const senderRow = await c.env.DB.prepare(
      `SELECT id, domain_id, local_part FROM email_senders WHERE id = ? AND disabled_at IS NULL`,
    )
      .bind(senderId)
      .first<{ id: string; domain_id: string; local_part: string }>();
    if (!senderRow) return buildError(c, 'not_found', 'sender not found or disabled');
    const domRow = await c.env.DB.prepare(
      `SELECT domain FROM outbound_domains WHERE id = ?`,
    )
      .bind(senderRow.domain_id)
      .first<{ domain: string }>();
    if (!domRow) return buildError(c, 'not_found', 'sender domain missing');
    const sender = {
      sender_id: senderRow.id,
      local_part: senderRow.local_part,
      domain: domRow.domain,
    };
    const id = ulid();
    const now = Date.now();
    const username = `${sender.local_part}@${sender.domain}`;
    const secret = generateSecret();
    const hashed = await hashSecret(secret, c.env.ARGON2_PEPPER);
    // Pre-compute the mox-pending-ops row so the credential insert + the queued
    // op flip into D1 atomically (D1 .batch() is the transactional primitive
    // available to Workers). The sidecar drains the queue on its next ~5s
    // config-poll tick and bcrypts the plaintext into Mox via SetPassword.
    // SECURITY: payload_b64 is plaintext-bearing — must NEVER be logged.
    const opId = ulid();
    const payloadB64 = btoa(secret);
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO smtp_credentials
             (id, sender_id, username, password_hash, label, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(id, senderId, username, hashed, body.label ?? null, now),
        c.env.DB.prepare(
          `INSERT INTO mox_pending_ops
             (id, op, username, payload_b64, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).bind(opId, 'set_password', username, payloadB64, now),
      ]);
    } catch (e) {
      if (String(e).includes('UNIQUE'))
        return buildError(c, 'conflict', 'username already in use');
      throw e;
    }
    await audit(c.env, {
      actor: `key:${key.key_id}`,
      action: 'smtp_credential.issue',
      target: id,
      meta: { sender_id: senderId, username },
    });
    return c.json(
      {
        id,
        username,
        // The plaintext is returned once at issuance and never again.
        secret,
        created_at: now,
      },
      201,
    );
  },
);

// ---------- soft-disable SMTP credential ----------
senders.delete('/v1/admin/smtp-credentials/:id', requireScope('admin:rotate'), async (c) => {
  const key = c.get('apiKey');
  const id = c.req.param('id');
  const now = Date.now();
  const r = await c.env.DB.prepare(
    `UPDATE smtp_credentials SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL`,
  )
    .bind(now, id)
    .run();
  if (r.meta.changes === 0) return buildError(c, 'not_found', 'not found or already disabled');
  await audit(c.env, {
    actor: `key:${key.key_id}`,
    action: 'smtp_credential.disable',
    target: id,
    meta: {},
  });
  return c.json({ id, disabled_at: now });
});

// ---------- list SMTP credentials under a sender ----------
senders.get(
  '/v1/admin/senders/:id/smtp-credentials',
  requireScope('admin:read'),
  async (c) => {
    const senderId = c.req.param('id');
    const rows = await c.env.DB.prepare(
      `SELECT id, sender_id, username, label, last_used_at, disabled_at, created_at
       FROM smtp_credentials WHERE sender_id = ? ORDER BY created_at DESC`,
    )
      .bind(senderId)
      .all();
    return c.json({ data: rows.results });
  },
);
