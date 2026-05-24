// Unified mailbox-credential routes.
//
// One endpoint set owns issuance / list / rotate / revoke for all five
// credential types — IMAP, SMTP, REST, MCP, CLI — backed by the
// `mailbox_credentials` table. Polaris Mail is pre-production: there is
// no backward-compat layer here, no legacy {protocol, username} body
// shape, no shimmed response fields.
//
// Token formats:
//   * IMAP — USER = pmimap_<26-ULID>, PASS = <52-char Crockford base32>
//   * SMTP — USER = pmsmtp_<26-ULID>, PASS = <52-char Crockford base32>
//   * REST — bearer = pmtk_<26-ULID>.<52-base32>  (also usable as
//            key_id + key_secret pair for HMAC-signed requests)
//   * MCP  — bearer = pmmcp_<26-ULID>.<52-base32>  (verifier-only;
//            no consumer endpoint yet)
//   * CLI  — bearer = pmcli_<26-ULID>.<52-base32>  (same)
//
// Audit actions reuse mailbox_credential.{issue,rotate,disable} with a
// `type` discriminator in the meta JSON.

import { Hono } from 'hono';
import { ulid } from '@polaris-mail/ids';
import { generateSecret } from '@polaris-mail/hmac';
import { actorOf, audit } from '../../audit.js';
import { requireScope } from '../../auth.js';
import { hashForType } from '../../lib/cred-hash.js';
import { formatBearer } from '../../lib/parse-bearer.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';

export const mailboxCredentials = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Type model
// ---------------------------------------------------------------------------

const ALL_TYPES = ['imap', 'smtp', 'rest', 'mcp', 'cli'] as const;
type CredentialType = (typeof ALL_TYPES)[number];

const PREFIX_FOR_TYPE: Record<CredentialType, string> = {
  imap: 'pmimap_',
  smtp: 'pmsmtp_',
  rest: 'pmtk_',
  mcp: 'pmmcp_',
  cli: 'pmcli_',
};

interface CredentialRow {
  id: string;
  mailbox_id: string;
  type: CredentialType;
  prefix: string;
  secret_hash: string;
  secret_prev_hash: string | null;
  receiver_id: string | null;
  display_name: string | null;
  status: 'primary' | 'secondary' | 'revoked';
  rate_limit_per_min: number;
  created_at: string;
  last_used_at: string | null;
  last_used_ip: string | null;
  disabled_at: string | null;
  revoked_at: string | null;
}

// Public list/detail shape — strips both hashes so the response never
// carries either the current or rotation-prev secret material.
function publicView(row: CredentialRow): Omit<CredentialRow, 'secret_hash' | 'secret_prev_hash'> {
  const { secret_hash: _sh, secret_prev_hash: _sp, ...rest } = row;
  void _sh;
  void _sp;
  return rest;
}

async function mailboxExists(env: Env, mailboxId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT id FROM mailboxes WHERE id = ?1 LIMIT 1`)
    .bind(mailboxId)
    .first<{ id: string }>();
  return !!row;
}

async function receiverBelongsToMailbox(
  env: Env,
  receiverId: string,
  mailboxId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT id FROM mailbox_receivers WHERE id = ?1 AND mailbox_id = ?2 LIMIT 1`,
  )
    .bind(receiverId, mailboxId)
    .first<{ id: string }>();
  return !!row;
}

// ---------------------------------------------------------------------------
// GET /v1/admin/mailboxes/:id/credentials — list
// ---------------------------------------------------------------------------

mailboxCredentials.get(
  '/v1/admin/mailboxes/:id/credentials',
  requireScope('admin:read'),
  async (c) => {
    const mailboxId = c.req.param('id');
    if (!(await mailboxExists(c.env, mailboxId))) {
      return buildError(c, 'not_found', 'mailbox not found');
    }
    const rows = await c.env.DB.prepare(
      `SELECT id, mailbox_id, type, prefix, secret_hash, secret_prev_hash,
              receiver_id, display_name, status, rate_limit_per_min,
              created_at, last_used_at, last_used_ip, disabled_at, revoked_at
       FROM mailbox_credentials
       WHERE mailbox_id = ?1
       ORDER BY created_at ASC`,
    )
      .bind(mailboxId)
      .all<CredentialRow>();
    return c.json({ data: rows.results.map(publicView) });
  },
);

// ---------------------------------------------------------------------------
// POST /v1/admin/mailboxes/:id/credentials — issue
// ---------------------------------------------------------------------------

interface IssueBody {
  type?: CredentialType;
  display_name?: string;
  receiver_id?: string;
}

interface NormalisedIssueArgs {
  type: CredentialType;
  display_name: string | null;
  receiver_id: string | null;
}

function normaliseIssueBody(
  raw: IssueBody,
): { ok: true; args: NormalisedIssueArgs } | { ok: false; error: string } {
  const type = raw.type;
  if (!type || !(ALL_TYPES as readonly string[]).includes(type)) {
    return { ok: false, error: 'type must be one of imap|smtp|rest|mcp|cli' };
  }
  if (type === 'imap' && !raw.receiver_id) {
    return { ok: false, error: 'receiver_id required for type=imap' };
  }
  if (type !== 'imap' && raw.receiver_id) {
    return { ok: false, error: 'receiver_id only valid for type=imap' };
  }
  return {
    ok: true,
    args: {
      type,
      display_name: raw.display_name ?? null,
      receiver_id: raw.receiver_id ?? null,
    },
  };
}

mailboxCredentials.post(
  '/v1/admin/mailboxes/:id/credentials',
  requireScope('admin:rotate'),
  async (c) => {
    const mailboxId = c.req.param('id');
    if (!(await mailboxExists(c.env, mailboxId))) {
      return buildError(c, 'not_found', 'mailbox not found');
    }

    let body: IssueBody;
    try {
      body = (await c.req.json()) as IssueBody;
    } catch {
      return buildError(c, 'bad_request', 'invalid JSON');
    }
    const norm = normaliseIssueBody(body);
    if (!norm.ok) return buildError(c, 'bad_request', norm.error);
    const { type, display_name, receiver_id } = norm.args;

    if (receiver_id && !(await receiverBelongsToMailbox(c.env, receiver_id, mailboxId))) {
      return buildError(c, 'bad_request', 'receiver_id does not belong to this mailbox');
    }

    const id = ulid();
    const secret = generateSecret();
    const secretHash = await hashForType(type, secret, c.env);
    const prefix = PREFIX_FOR_TYPE[type];
    const createdAt = new Date().toISOString();

    await c.env.DB.prepare(
      `INSERT INTO mailbox_credentials
         (id, mailbox_id, type, prefix, secret_hash, receiver_id,
          display_name, status, rate_limit_per_min, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'primary', 60, ?8)`,
    )
      .bind(id, mailboxId, type, prefix, secretHash, receiver_id, display_name, createdAt)
      .run();

    // KV cache — `mc:` prefix namespaces these away from operator
    // (`plain:`/`key:`) + bridge (`bridge_plain:`) entries. Plaintext
    // cache window is 1h to match the pk_live_ legacy convention and
    // give HMAC-signed clients headroom across colo propagation.
    await c.env.KV_KEY_CACHE.put(`mc:plain:${id}`, secret, { expirationTtl: 60 * 60 });
    await c.env.KV_KEY_CACHE.put(
      `mc:row:${id}`,
      JSON.stringify({
        id,
        mailbox_id: mailboxId,
        type,
        prefix,
        receiver_id,
        secret_hash: secretHash,
        secret_prev_hash: null,
        status: 'primary',
        revoked_at: null,
        disabled_at: null,
      }),
      { expirationTtl: 60 },
    );

    await audit(c.env, {
      actor: actorOf(c),
      action: 'mailbox_credential.issue',
      target: id,
      meta: { mailbox_id: mailboxId, type, prefix, receiver_id, display_name },
    });

    const base = {
      id,
      mailbox_id: mailboxId,
      type,
      prefix,
      display_name,
      receiver_id,
      created_at: createdAt,
    };
    if (type === 'imap' || type === 'smtp') {
      return c.json({ ...base, username: `${prefix}${id}`, password: secret }, 201);
    }
    return c.json(
      {
        ...base,
        key_id: id,
        key_secret: secret,
        bearer: formatBearer(type, id, secret),
      },
      201,
    );
  },
);

// ---------------------------------------------------------------------------
// POST /v1/admin/mailboxes/:id/credentials/:credId/rotate
// ---------------------------------------------------------------------------

interface RotateBody {
  mode?: 'planned' | 'emergency';
}

mailboxCredentials.post(
  '/v1/admin/mailboxes/:id/credentials/:credId/rotate',
  requireScope('admin:rotate'),
  async (c) => {
    const mailboxId = c.req.param('id');
    const credId = c.req.param('credId');
    let body: RotateBody = {};
    try {
      body = (await c.req.json().catch(() => ({}))) as RotateBody;
    } catch {
      body = {};
    }
    const mode: 'planned' | 'emergency' = body.mode === 'emergency' ? 'emergency' : 'planned';

    const row = await c.env.DB.prepare(
      `SELECT id, mailbox_id, type, prefix, secret_hash, secret_prev_hash,
              receiver_id, display_name, status, rate_limit_per_min,
              created_at, last_used_at, last_used_ip, disabled_at, revoked_at
       FROM mailbox_credentials WHERE id = ?1 AND mailbox_id = ?2 LIMIT 1`,
    )
      .bind(credId, mailboxId)
      .first<CredentialRow>();
    if (!row) return buildError(c, 'not_found', 'credential not found');
    if (row.disabled_at) return buildError(c, 'conflict', 'credential disabled');
    if (row.revoked_at) return buildError(c, 'conflict', 'credential revoked');

    const newSecret = generateSecret();
    const newHash = await hashForType(row.type, newSecret, c.env);
    // Planned: keep the old hash as secret_prev_hash for a grace window
    // so an in-flight client doesn't 401 mid-request. Emergency: drop
    // the previous immediately.
    const prevHash = mode === 'planned' ? row.secret_hash : null;
    await c.env.DB.prepare(
      `UPDATE mailbox_credentials
         SET secret_hash = ?1, secret_prev_hash = ?2
       WHERE id = ?3`,
    )
      .bind(newHash, prevHash, credId)
      .run();

    await c.env.KV_KEY_CACHE.put(`mc:plain:${credId}`, newSecret, { expirationTtl: 60 * 60 });
    await c.env.KV_KEY_CACHE.delete(`mc:row:${credId}`);

    await audit(c.env, {
      actor: actorOf(c),
      action: 'mailbox_credential.rotate',
      target: credId,
      meta: { mailbox_id: mailboxId, type: row.type, mode },
    });

    const base = {
      id: credId,
      mailbox_id: mailboxId,
      type: row.type,
      prefix: row.prefix,
    };
    if (row.type === 'imap' || row.type === 'smtp') {
      return c.json({ ...base, username: `${row.prefix}${credId}`, password: newSecret });
    }
    // Bearer types (rest/mcp/cli) — the CHECK constraint on the `type`
    // column makes this branch exhaustive.
    return c.json({
      ...base,
      key_id: credId,
      key_secret: newSecret,
      bearer: formatBearer(row.type, credId, newSecret),
    });
  },
);

// ---------------------------------------------------------------------------
// DELETE /v1/admin/mailboxes/:id/credentials/:credId — revoke
// ---------------------------------------------------------------------------

mailboxCredentials.delete(
  '/v1/admin/mailboxes/:id/credentials/:credId',
  requireScope('admin:rotate'),
  async (c) => {
    const mailboxId = c.req.param('id');
    const credId = c.req.param('credId');
    const row = await c.env.DB.prepare(
      `SELECT id, type FROM mailbox_credentials WHERE id = ?1 AND mailbox_id = ?2 LIMIT 1`,
    )
      .bind(credId, mailboxId)
      .first<{ id: string; type: CredentialType }>();
    if (!row) return buildError(c, 'not_found', 'credential not found');

    const now = new Date().toISOString();
    await c.env.DB.prepare(
      `UPDATE mailbox_credentials
         SET disabled_at = ?1, revoked_at = ?1, status = 'revoked'
       WHERE id = ?2`,
    )
      .bind(now, credId)
      .run();
    await c.env.KV_KEY_CACHE.delete(`mc:plain:${credId}`);
    await c.env.KV_KEY_CACHE.delete(`mc:row:${credId}`);

    await audit(c.env, {
      actor: actorOf(c),
      action: 'mailbox_credential.disable',
      target: credId,
      meta: { mailbox_id: mailboxId, type: row.type },
    });
    return new Response(null, { status: 204 });
  },
);
