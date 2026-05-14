// Unified mailbox credentials (Phase L).
//
// Backs the SMTPS / IMAP / JMAP auth flows: one row per (mailbox, protocol,
// username|bearer). Plaintext secrets are returned exactly once at issue /
// rotate time; thereafter only the bcrypt hash or stored bearer token is
// visible.
//
// Audit actions:
//   * mailbox_credential.issue
//   * mailbox_credential.rotate
//   * mailbox_credential.disable
// All three were widened into `audit_log.action` by 0003_audit_actions.sql.

import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import { ulid } from '@polaris-email/ids';
import { MailBridgeAuthType, MailBridgeProtocol } from '@polaris-email/schema';
import { audit } from '../../audit.js';
import { requireScope } from '../../auth.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';

export const credentialsMailbox = new Hono<{ Bindings: Env }>();

interface CredentialRow {
  id: string;
  mailbox_id: string;
  protocol: 'smtps' | 'imap' | 'jmap';
  auth_type: 'password' | 'bearer_token';
  username: string | null;
  bcrypt_hash: string | null;
  bearer_token: string | null;
  created_at: string;
  last_used_at: string | null;
  disabled_at: string | null;
}

function publicView(row: CredentialRow): Omit<CredentialRow, 'bcrypt_hash' | 'bearer_token'> {
  const { bcrypt_hash: _h, bearer_token: _b, ...rest } = row;
  void _h;
  void _b;
  return rest;
}

function randomBase64(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin);
}

function randomBase64Url(bytes: number): string {
  return randomBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
    const rows = await c.env.DB.prepare(
      `SELECT id, mailbox_id, protocol, auth_type, username, bcrypt_hash, bearer_token,
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
    let body: { protocol?: string; auth_type?: string; username?: string };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return buildError(c, 'bad_request', 'invalid JSON');
    }
    const protocolParse = MailBridgeProtocol.safeParse(body.protocol);
    if (!protocolParse.success) {
      return buildError(c, 'bad_request', 'protocol must be smtps|imap|jmap');
    }
    const authTypeParse = MailBridgeAuthType.safeParse(body.auth_type);
    if (!authTypeParse.success) {
      return buildError(c, 'bad_request', 'auth_type must be password|bearer_token');
    }
    const protocol = protocolParse.data;
    const authType = authTypeParse.data;
    if (authType === 'password' && (!body.username || body.username.length < 1)) {
      return buildError(c, 'bad_request', 'username required for password auth');
    }
    if (protocol === 'jmap' && authType !== 'bearer_token') {
      return buildError(c, 'bad_request', 'jmap requires bearer_token');
    }

    const id = ulid();
    const createdAt = new Date().toISOString();
    let plaintext: string;
    let bcryptHash: string | null = null;
    let bearerToken: string | null = null;
    if (authType === 'password') {
      plaintext = randomBase64(32);
      bcryptHash = await bcrypt.hash(plaintext, 10);
    } else {
      plaintext = randomBase64Url(48);
      bearerToken = plaintext;
    }
    await c.env.DB.prepare(
      `INSERT INTO mailbox_credentials
        (id, mailbox_id, protocol, auth_type, username, bcrypt_hash, bearer_token,
         created_at, last_used_at, disabled_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, NULL)`,
    )
      .bind(
        id,
        mailboxId,
        protocol,
        authType,
        authType === 'password' ? (body.username ?? null) : null,
        bcryptHash,
        bearerToken,
        createdAt,
      )
      .run();

    await audit(c.env, {
      actor: c.get('apiKey')?.principal_id ?? 'admin',
      action: 'mailbox_credential.issue',
      target: id,
      meta: { mailbox_id: mailboxId, protocol, auth_type: authType },
    });

    return c.json({ id, mailbox_id: mailboxId, protocol, auth_type: authType, plaintext }, 201);
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
      `SELECT id, mailbox_id, protocol, auth_type, username, bcrypt_hash, bearer_token,
              created_at, last_used_at, disabled_at
       FROM mailbox_credentials WHERE id = ?1 AND mailbox_id = ?2 LIMIT 1`,
    )
      .bind(credId, mailboxId)
      .first<CredentialRow>();
    if (!row) return buildError(c, 'not_found', 'credential not found');
    if (row.disabled_at) return buildError(c, 'conflict', 'credential disabled');

    let plaintext: string;
    if (row.auth_type === 'password') {
      plaintext = randomBase64(32);
      const hash = await bcrypt.hash(plaintext, 10);
      await c.env.DB.prepare(`UPDATE mailbox_credentials SET bcrypt_hash = ?1 WHERE id = ?2`)
        .bind(hash, credId)
        .run();
    } else {
      plaintext = randomBase64Url(48);
      await c.env.DB.prepare(`UPDATE mailbox_credentials SET bearer_token = ?1 WHERE id = ?2`)
        .bind(plaintext, credId)
        .run();
    }
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
