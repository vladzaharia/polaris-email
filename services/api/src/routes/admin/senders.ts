// Admin REST routes for mailbox_senders (the domain-scoped sender list) and
// submission_credentials. The mailbox-scoped sender CRUD lives in
// `./mailboxes.ts`; this file keeps the historic domain-scoped variants the
// CLI/panel still call, plus all SMTP-credential issuance.
//
// Submission credentials bind 1:1 to a `mailbox_senders` row via
// `submission_credentials.sender_id` per the canonical schema; the daemon's
// SMTP MAIL FROM allow-list is therefore exactly one address.
import { Hono } from 'hono';
import { CreateMailboxSenderRequest, CreateSmtpCredentialRequest } from '@polaris-email/schema';
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
  mailbox_id: string;
  domain_id: string;
  address: string;
  local_part: string | null;
  default_for_mailbox: number;
  created_at: string;
  disabled_at: string | null;
}

// ---------- create sender under a domain ----------
// The request body MUST carry `mailbox_id` (the sender's owning mailbox);
// `domain_id` is sourced from the URL path.
senders.post('/v1/admin/domains/:domainId/senders', requireScope('admin:rotate'), async (c) => {
  const key = c.get('apiKey');
  const domainId = c.req.param('domainId');
  let body: ReturnType<typeof CreateMailboxSenderRequest.parse> & { mailbox_id?: string };
  try {
    const raw = JSON.parse(bodyText(c)) as Record<string, unknown>;
    body = CreateMailboxSenderRequest.parse(raw) as typeof body;
    body.mailbox_id = typeof raw.mailbox_id === 'string' ? raw.mailbox_id : undefined;
  } catch (e) {
    return buildError(c, 'bad_request', e instanceof Error ? e.message : 'invalid body');
  }
  // Resolve the mailbox: explicit `mailbox_id`, or the bootstrap operator
  // mailbox as a sensible default for single-tenant deployments + tests.
  let mailboxId = body.mailbox_id;
  if (!mailboxId) {
    const fallback = await c.env.DB.prepare(
      `SELECT id FROM mailboxes ORDER BY created_at ASC LIMIT 1`,
    ).first<{ id: string }>();
    if (!fallback) return buildError(c, 'bad_request', 'mailbox_id required');
    mailboxId = fallback.id;
  }
  const dom = await c.env.DB.prepare(`SELECT id, name FROM mail_domains WHERE id = ?`)
    .bind(domainId)
    .first<{ id: string; name: string }>();
  if (!dom) return buildError(c, 'not_found', 'mail_domain not found');
  const id = ulid();
  const nowIso = new Date().toISOString();
  const isDefault = body.default_for_mailbox ? 1 : 0;
  const address = `${body.local_part}@${dom.name}`;
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
           (id, mailbox_id, domain_id, address, local_part,
            default_for_mailbox, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, mailboxId, domainId, address, body.local_part, isDefault, nowIso)
      .run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) return buildError(c, 'conflict', 'address already in use');
    throw e;
  }
  await audit(c.env, {
    actor: `key:${key.key_id}`,
    action: 'mailbox_sender.create',
    target: id,
    meta: {
      mailbox_id: mailboxId,
      domain_id: domainId,
      local_part: body.local_part,
      default: isDefault === 1,
    },
  });
  return c.json(
    {
      id,
      address,
      mailbox_id: mailboxId,
      domain_id: domainId,
      default_for_mailbox: isDefault === 1,
      created_at: Date.now(),
    },
    201,
  );
});

// ---------- list senders under a domain ----------
senders.get('/v1/admin/domains/:domainId/senders', requireScope('admin:read'), async (c) => {
  const domainId = c.req.param('domainId');
  const rows = await c.env.DB.prepare(
    `SELECT id, mailbox_id, domain_id, address, local_part, default_for_mailbox,
              created_at, disabled_at
       FROM mailbox_senders WHERE domain_id = ?
       ORDER BY default_for_mailbox DESC, address ASC`,
  )
    .bind(domainId)
    .all<SenderRow>();
  return c.json({ data: rows.results });
});

// ---------- soft-disable sender ----------
senders.delete('/v1/admin/senders/:id', requireScope('admin:rotate'), async (c) => {
  const key = c.get('apiKey');
  const id = c.req.param('id');
  const nowIso = new Date().toISOString();
  const r = await c.env.DB.prepare(
    `UPDATE mailbox_senders SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL`,
  )
    .bind(nowIso, id)
    .run();
  if (r.meta.changes === 0) {
    return buildError(c, 'not_found', 'not found or already disabled');
  }
  await audit(c.env, {
    actor: `key:${key.key_id}`,
    action: 'mailbox_sender.disable',
    target: id,
    meta: {},
  });
  return c.json({ id, disabled_at: Date.now() });
});

// ---------- issue submission credential ----------
//
// The sender's owning mailbox supplies the principal's mailbox_id; the new
// `submission_credentials.sender_id` column makes the principal↔sender binding
// explicit (1:1, replacing the old principal_sender_scopes junction).
senders.post('/v1/admin/senders/:id/smtp-credentials', requireScope('admin:rotate'), async (c) => {
  const key = c.get('apiKey');
  const senderId = c.req.param('id');
  try {
    CreateSmtpCredentialRequest.parse(JSON.parse(bodyText(c) || '{}'));
  } catch (e) {
    return buildError(c, 'bad_request', e instanceof Error ? e.message : 'invalid body');
  }
  const senderRow = await c.env.DB.prepare(
    `SELECT id, mailbox_id, domain_id, address FROM mailbox_senders
       WHERE id = ? AND disabled_at IS NULL`,
  )
    .bind(senderId)
    .first<{ id: string; mailbox_id: string; domain_id: string; address: string }>();
  if (!senderRow) return buildError(c, 'not_found', 'sender not found or disabled');
  const domRow = await c.env.DB.prepare(`SELECT id, name FROM mail_domains WHERE id = ?`)
    .bind(senderRow.domain_id)
    .first<{ id: string; name: string }>();
  if (!domRow) return buildError(c, 'not_found', 'sender domain missing');

  const id = ulid();
  const principalId = ulid();
  const nowIso = new Date().toISOString();
  const username = senderRow.address;
  const secret = generateSecret();
  // Hash the secret before persistence — D1 only ever sees the hash. The
  // submission daemon polls /v1/daemon/credentials and mirrors the hash
  // locally; the plaintext is returned to the caller exactly once below.
  const hashed = await hashSecret(secret, c.env.ARGON2_PEPPER);

  // 1) Create the principal (kind='smtp_cred') bound to the sender's mailbox.
  await c.env.DB.prepare(
    `INSERT INTO principals (id, mailbox_id, kind, created_at)
       VALUES (?, ?, 'smtp_cred', ?)`,
  )
    .bind(principalId, senderRow.mailbox_id, nowIso)
    .run();
  // 2) Insert the submission_credentials row (sender_id makes the binding explicit).
  try {
    await c.env.DB.prepare(
      `INSERT INTO submission_credentials
           (id, principal_id, sender_id, username, bcrypt_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, principalId, senderId, username, hashed, nowIso)
      .run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) return buildError(c, 'conflict', 'username already in use');
    throw e;
  }
  await audit(c.env, {
    actor: `key:${key.key_id}`,
    action: 'smtp_credential.issue',
    target: id,
    meta: {
      sender_id: senderId,
      principal_id: principalId,
      mailbox_id: senderRow.mailbox_id,
      username,
    },
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
});

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
senders.get('/v1/admin/senders/:id/smtp-credentials', requireScope('admin:read'), async (c) => {
  const senderId = c.req.param('id');
  const rows = await c.env.DB.prepare(
    `SELECT id, principal_id, sender_id, username, last_used_at, disabled_at, created_at
       FROM submission_credentials WHERE sender_id = ? ORDER BY created_at DESC`,
  )
    .bind(senderId)
    .all();
  return c.json({ data: rows.results });
});
