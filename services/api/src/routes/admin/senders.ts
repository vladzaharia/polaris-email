// Admin REST routes for mailbox_senders (the domain-scoped sender list).
// The mailbox-scoped sender CRUD lives in `./mailboxes.ts`; this file
// keeps the historic domain-scoped variants the CLI/panel still call.
// SMTP submission credentials moved to the unified mailbox_credentials
// model — operators mint them via the mailbox credentials endpoint.
import { Hono } from 'hono';
import { CreateMailboxSenderRequest } from '@polaris-mail/schema';
import { actorOf, audit } from '../../audit.js';
import { bodyText, requireScope } from '../../auth.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';
import { ulid } from '@polaris-mail/ids';

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
    actor: actorOf(c),
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
    actor: actorOf(c),
    action: 'mailbox_sender.disable',
    target: id,
    meta: {},
  });
  return c.json({ id, disabled_at: Date.now() });
});

// SMTP submission credentials (formerly issued per-sender via
// /v1/admin/senders/:id/smtp-credentials) were folded into the unified
// mailbox_credentials model in migration 0003. SMTP creds are now
// mailbox-scoped (not sender-bound) — operators mint them via
// POST /v1/admin/mailboxes/:id/credentials with type='smtp', and the
// bridge validates MAIL FROM against `mailbox_senders` per session.
