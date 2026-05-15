// Unified mailbox credentials (Phase L + B6).
//
// Backs the SMTPS / IMAP auth flows: one row per (mailbox, protocol, username).
// JMAP support was removed by C1 + B6 (read-once secrets migration drops the
// `bearer_token` column and all `auth_type='bearer_token'` rows).
//
// Read-once secret discipline:
//   * POST /v1/admin/mailboxes/:id/credentials returns the plaintext password
//     ONCE in the response body. D1 only ever stores the bcrypt hash.
//   * POST /.../credentials/:credId/rotate returns the new plaintext ONCE.
//   * GET /v1/admin/mailboxes/:id/credentials strips the hash. There is no
//     way to read a credential's secret after issue/rotate.
//
// Audit actions:
//   * mailbox_credential.issue
//   * mailbox_credential.rotate
//   * mailbox_credential.disable
// All three were widened into `audit_log.action` by 0003_audit_actions.sql.

import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import { ulid } from '@polaris-email/ids';
import { MailBridgeProtocol } from '@polaris-email/schema';
import { audit } from '../../audit.js';
import { requireScope } from '../../auth.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';

export const credentialsMailbox = new Hono<{ Bindings: Env }>();

interface CredentialRow {
  id: string;
  mailbox_id: string;
  protocol: 'smtps' | 'imap';
  auth_type: 'password';
  username: string;
  bcrypt_hash: string;
  created_at: string;
  last_used_at: string | null;
  disabled_at: string | null;
}

// Public GET shape: drop the hash so GETs cannot leak it. Per A11.
function publicView(row: CredentialRow): Omit<CredentialRow, 'bcrypt_hash'> {
  const { bcrypt_hash: _h, ...rest } = row;
  void _h;
  return rest;
}

function randomBase64(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function mailboxExists(env: Env, mailboxId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT id FROM mailboxes WHERE id = ?1 LIMIT 1`)
    .bind(mailboxId)
    .first<{ id: string }>();
  return !!row;
}

// ---------- GET /v1/admin/mailboxes/:id/credentials ----------
credentialsMailbox.get(
  '/v1/admin/mailboxes/:id/credentials',
  requireScope('admin:read'),
  async (c) => {
    const mailboxId = c.req.param('id');
    if (!(await mailboxExists(c.env, mailboxId))) {
      return buildError(c, 'not_found', 'mailbox not found');
    }
    // Note: bcrypt_hash is SELECTed only so `publicView` can strip it
    // explicitly in one place; the response never carries it.
    const rows = await c.env.DB.prepare(
      `SELECT id, mailbox_id, protocol, auth_type, username, bcrypt_hash,
              created_at, last_used_at, disabled_at
       FROM mailbox_credentials WHERE mailbox_id = ?1 ORDER BY created_at ASC`,
    )
      .bind(mailboxId)
      .all<CredentialRow>();
    return c.json({ data: rows.results.map(publicView) });
  },
);

// ---------- POST /v1/admin/mailboxes/:id/credentials ----------
credentialsMailbox.post(
  '/v1/admin/mailboxes/:id/credentials',
  requireScope('admin:rotate'),
  async (c) => {
    const mailboxId = c.req.param('id');
    if (!(await mailboxExists(c.env, mailboxId))) {
      return buildError(c, 'not_found', 'mailbox not found');
    }
    let body: { protocol?: string; username?: string };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return buildError(c, 'bad_request', 'invalid JSON');
    }
    const protocolParse = MailBridgeProtocol.safeParse(body.protocol);
    if (!protocolParse.success) {
      return buildError(c, 'bad_request', 'protocol must be smtps|imap');
    }
    const protocol = protocolParse.data;
    if (!body.username || body.username.length < 1) {
      return buildError(c, 'bad_request', 'username required');
    }

    const id = ulid();
    const createdAt = new Date().toISOString();
    // Server generates the plaintext, hashes it, returns it once.
    // Cost 12 — must match the dummy-hash burn cost in mail-bridge
    // (apps/mail-bridge/internal/smtp/session.go) so a real verify on
    // hit takes the same wall time as a real verify on miss. Any
    // mismatch leaks valid-username signal via timing.
    const plaintext = randomBase64(32);
    const bcryptHash = await bcrypt.hash(plaintext, 12);

    await c.env.DB.prepare(
      `INSERT INTO mailbox_credentials
        (id, mailbox_id, protocol, auth_type, username, bcrypt_hash,
         created_at, last_used_at, disabled_at)
       VALUES (?1, ?2, ?3, 'password', ?4, ?5, ?6, NULL, NULL)`,
    )
      .bind(id, mailboxId, protocol, body.username, bcryptHash, createdAt)
      .run();

    await audit(c.env, {
      actor: c.get('apiKey')?.principal_id ?? 'admin',
      action: 'mailbox_credential.issue',
      target: id,
      meta: { mailbox_id: mailboxId, protocol, auth_type: 'password' },
    });

    // The plaintext is returned once; the DB only ever sees the hash.
    return c.json(
      { id, mailbox_id: mailboxId, protocol, auth_type: 'password' as const, plaintext },
      201,
    );
  },
);

// ---------- POST /v1/admin/mailboxes/:id/credentials/:credId/rotate ----------
credentialsMailbox.post(
  '/v1/admin/mailboxes/:id/credentials/:credId/rotate',
  requireScope('admin:rotate'),
  async (c) => {
    const mailboxId = c.req.param('id');
    const credId = c.req.param('credId');
    const row = await c.env.DB.prepare(
      `SELECT id, mailbox_id, protocol, auth_type, username, bcrypt_hash,
              created_at, last_used_at, disabled_at
       FROM mailbox_credentials WHERE id = ?1 AND mailbox_id = ?2 LIMIT 1`,
    )
      .bind(credId, mailboxId)
      .first<CredentialRow>();
    if (!row) return buildError(c, 'not_found', 'credential not found');
    if (row.disabled_at) return buildError(c, 'conflict', 'credential disabled');

    // Fresh plaintext, fresh hash. Cost 12 — see issuance comment.
    const plaintext = randomBase64(32);
    const hash = await bcrypt.hash(plaintext, 12);
    await c.env.DB.prepare(`UPDATE mailbox_credentials SET bcrypt_hash = ?1 WHERE id = ?2`)
      .bind(hash, credId)
      .run();

    await audit(c.env, {
      actor: c.get('apiKey')?.principal_id ?? 'admin',
      action: 'mailbox_credential.rotate',
      target: credId,
      meta: { mailbox_id: mailboxId, protocol: row.protocol, auth_type: row.auth_type },
    });
    return c.json({ id: credId, plaintext });
  },
);

// ---------- DELETE /v1/admin/mailboxes/:id/credentials/:credId ----------
credentialsMailbox.delete(
  '/v1/admin/mailboxes/:id/credentials/:credId',
  requireScope('admin:rotate'),
  async (c) => {
    const mailboxId = c.req.param('id');
    const credId = c.req.param('credId');
    const row = await c.env.DB.prepare(
      `SELECT id FROM mailbox_credentials WHERE id = ?1 AND mailbox_id = ?2 LIMIT 1`,
    )
      .bind(credId, mailboxId)
      .first<{ id: string }>();
    if (!row) return buildError(c, 'not_found', 'credential not found');
    await c.env.DB.prepare(`UPDATE mailbox_credentials SET disabled_at = ?1 WHERE id = ?2`)
      .bind(new Date().toISOString(), credId)
      .run();
    await audit(c.env, {
      actor: c.get('apiKey')?.principal_id ?? 'admin',
      action: 'mailbox_credential.disable',
      target: credId,
      meta: { mailbox_id: mailboxId },
    });
    return new Response(null, { status: 204 });
  },
);
