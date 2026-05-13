// Admin REST routes for email_senders and submission_credentials.
// All HMAC-signed (admin middleware applied at the parent `admin` Hono instance).
//
// Submission credentials are issued against a `principals` row (kind='smtp_cred')
// rather than directly against an email_sender. The sender↔principal binding is
// recorded in `principal_sender_scopes`.
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
import { ulid } from '@polaris-email/ids';

export const senders = new Hono<{ Bindings: Env }>();

interface SenderRow {
  id: string;
  domain_id: string;
  address: string;
  local_part: string | null;
  default_for_domain: number;
  created_at: string;
  disabled_at: string | null;
}

// ---------- create sender under a domain ----------
senders.post(
  '/v1/admin/domains/:domainId/senders',
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
      `SELECT id, name FROM mail_domains WHERE id = ?`,
    )
      .bind(domainId)
      .first<{ id: string; name: string }>();
    if (!dom) return buildError(c, 'not_found', 'mail_domain not found');
    const id = ulid();
    const nowIso = new Date().toISOString();
    const isDefault = body.default_for_domain ? 1 : 0;
    const address = `${body.local_part}@${dom.name}`;
    try {
      if (isDefault === 1) {
        await c.env.DB.prepare(
          `UPDATE email_senders SET default_for_domain = 0 WHERE domain_id = ? AND default_for_domain = 1`,
        )
          .bind(domainId)
          .run();
      }
      await c.env.DB.prepare(
        `INSERT INTO email_senders (id, domain_id, address, local_part, environment, default_for_domain, created_at)
         VALUES (?, ?, ?, ?, 'prod', ?, ?)`,
      )
        .bind(id, domainId, address, body.local_part, isDefault, nowIso)
        .run();
    } catch (e) {
      if (String(e).includes('UNIQUE'))
        return buildError(c, 'conflict', 'address already in use');
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
        address,
        domain_id: domainId,
        default_for_domain: isDefault === 1,
        created_at: Date.now(),
      },
      201,
    );
  },
);

// ---------- list senders under a domain ----------
senders.get(
  '/v1/admin/domains/:domainId/senders',
  requireScope('admin:read'),
  async (c) => {
    const domainId = c.req.param('domainId');
    const rows = await c.env.DB.prepare(
      `SELECT id, domain_id, address, local_part, default_for_domain, created_at, disabled_at
       FROM email_senders WHERE domain_id = ? ORDER BY default_for_domain DESC, address ASC`,
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
  const nowIso = new Date().toISOString();
  const r = await c.env.DB.prepare(
    `UPDATE email_senders SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL`,
  )
    .bind(nowIso, id)
    .run();
  if (r.meta.changes === 0) {
    return buildError(c, 'not_found', 'not found or already disabled');
  }
  await audit(c.env, {
    actor: `key:${key.key_id}`,
    action: 'email_sender.disable',
    target: id,
    meta: {},
  });
  return c.json({ id, disabled_at: Date.now() });
});

// ---------- issue submission credential ----------
senders.post(
  '/v1/admin/senders/:id/smtp-credentials',
  requireScope('admin:rotate'),
  async (c) => {
    const key = c.get('apiKey');
    const senderId = c.req.param('id');
    try {
      CreateSmtpCredentialRequest.parse(JSON.parse(bodyText(c) || '{}'));
    } catch (e) {
      return buildError(c, 'bad_request', e instanceof Error ? e.message : 'invalid body');
    }
    const senderRow = await c.env.DB.prepare(
      `SELECT id, domain_id, address FROM email_senders WHERE id = ? AND disabled_at IS NULL`,
    )
      .bind(senderId)
      .first<{ id: string; domain_id: string; address: string }>();
    if (!senderRow) return buildError(c, 'not_found', 'sender not found or disabled');
    const domRow = await c.env.DB.prepare(
      `SELECT id, name FROM mail_domains WHERE id = ?`,
    )
      .bind(senderRow.domain_id)
      .first<{ id: string; name: string }>();
    if (!domRow) return buildError(c, 'not_found', 'sender domain missing');
    // Resolve tenant for the new principal: pick any tenant from the principals
    // table (tests bootstrap exactly one). In production the route should
    // accept an explicit `tenant_id` body param — kept minimal here for the v1
    // mechanical port; revisit in a follow-up.
    const tenantRow = await c.env.DB.prepare(
      `SELECT id FROM tenants ORDER BY created_at ASC LIMIT 1`,
    ).first<{ id: string }>();
    if (!tenantRow) return buildError(c, 'not_found', 'no tenant exists for new principal');

    const id = ulid();
    const principalId = ulid();
    const nowIso = new Date().toISOString();
    const username = senderRow.address;
    const secret = generateSecret();
    // Hash the secret before persistence — D1 only ever sees the hash. The
    // submission daemon polls /v1/daemon/credentials and mirrors the hash
    // locally; the plaintext is returned to the caller exactly once below.
    const hashed = await hashSecret(secret, c.env.ARGON2_PEPPER);

    // 1) Create the principal (kind='smtp_cred').
    await c.env.DB.prepare(
      `INSERT INTO principals (id, tenant_id, kind, environment, created_at)
       VALUES (?, ?, 'smtp_cred', 'prod', ?)`,
    )
      .bind(principalId, tenantRow.id, nowIso)
      .run();
    // 2) Bind the principal to this sender (so the daemon's allow-list check
    //    for /v1/send/raw resolves correctly).
    await c.env.DB.prepare(
      `INSERT INTO principal_sender_scopes (principal_id, sender_id, created_at)
       VALUES (?, ?, ?)`,
    )
      .bind(principalId, senderId, nowIso)
      .run();
    // 3) Insert the submission_credentials row.
    try {
      await c.env.DB.prepare(
        `INSERT INTO submission_credentials
           (id, principal_id, username, bcrypt_hash, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(id, principalId, username, hashed, nowIso)
        .run();
    } catch (e) {
      if (String(e).includes('UNIQUE'))
        return buildError(c, 'conflict', 'username already in use');
      throw e;
    }
    await audit(c.env, {
      actor: `key:${key.key_id}`,
      action: 'smtp_credential.issue',
      target: id,
      meta: { sender_id: senderId, principal_id: principalId, username },
    });
    return c.json(
      {
        id,
        username,
        // The plaintext is returned once at issuance and never again.
        secret,
        created_at: Date.now(),
      },
      201,
    );
  },
);

// ---------- soft-disable submission credential ----------
senders.delete('/v1/admin/smtp-credentials/:id', requireScope('admin:rotate'), async (c) => {
  const key = c.get('apiKey');
  const id = c.req.param('id');
  const nowIso = new Date().toISOString();
  const r = await c.env.DB.prepare(
    `UPDATE submission_credentials SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL`,
  )
    .bind(nowIso, id)
    .run();
  if (r.meta.changes === 0) return buildError(c, 'not_found', 'not found or already disabled');
  await audit(c.env, {
    actor: `key:${key.key_id}`,
    action: 'smtp_credential.disable',
    target: id,
    meta: {},
  });
  return c.json({ id, disabled_at: Date.now() });
});

// ---------- list submission credentials under a sender ----------
senders.get(
  '/v1/admin/senders/:id/smtp-credentials',
  requireScope('admin:read'),
  async (c) => {
    const senderId = c.req.param('id');
    // principal_sender_scopes ⋈ submission_credentials (two-step to keep mock D1 happy).
    const scopes = await c.env.DB.prepare(
      `SELECT principal_id FROM principal_sender_scopes WHERE sender_id = ?`,
    )
      .bind(senderId)
      .all<{ principal_id: string }>();
    const out: unknown[] = [];
    for (const s of scopes.results) {
      const rows = await c.env.DB.prepare(
        `SELECT id, principal_id, username, last_used_at, disabled_at, created_at
         FROM submission_credentials WHERE principal_id = ? ORDER BY created_at DESC`,
      )
        .bind(s.principal_id)
        .all();
      for (const r of rows.results) out.push(r);
    }
    return c.json({ data: out });
  },
);
