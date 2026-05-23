// Unified mailbox-credential routes (Phase 1 of the cred-refactor plan).
//
// One endpoint set owns issuance / list / rotate / revoke for all five
// credential types — IMAP, SMTP, REST, MCP, CLI — backed by the
// `mailbox_credentials_v2` table introduced in migration
// 0002_unified_credentials.sql.
//
// Supersedes the legacy module at `credentials-mailbox.ts`. The POST
// handler still accepts the legacy request shape `{ protocol, username }`
// so existing callers (panel IssueCredentialDialog, CLI) keep working
// without a coordinated cutover; the response is a superset (legacy
// fields plus the new `bearer` / `key_id` / `key_secret` ones) for the
// same reason.
//
// Audit actions: reuses existing `mailbox_credential.{issue,rotate,disable}`
// (packages/schema/src/index.ts:878-880) — the new `type` discriminator
// rides in the meta JSON, no audit-schema migration required.

import { Hono } from 'hono';
import { ulid } from '@polaris-mail/ids';
import { generateSecret } from '@polaris-mail/hmac';
import { actorOf, audit } from '../../audit.js';
import { requireScope } from '../../auth.js';
import { hashForType } from '../../lib/cred-hash.js';
import { formatBearer, type BearerType } from '../../lib/parse-bearer.js';
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

interface CredentialRowV2 {
  id: string;
  mailbox_id: string;
  type: CredentialType;
  prefix: string;
  secret_hash: string;
  secret_prev_hash: string | null;
  receiver_id: string | null;
  display_name: string | null;
  legacy_username: string | null;
  status: 'primary' | 'secondary' | 'revoked';
  rate_limit_per_min: number;
  created_at: string;
  last_used_at: string | null;
  last_used_ip: string | null;
  disabled_at: string | null;
  revoked_at: string | null;
}

// Public list/detail shape — strips both hashes so the response never
// carries either the current or the rotation-prev secret material.
function publicView(
  row: CredentialRowV2,
): Omit<CredentialRowV2, 'secret_hash' | 'secret_prev_hash'> {
  const { secret_hash: _sh, secret_prev_hash: _sp, ...rest } = row;
  void _sh;
  void _sp;
  return rest;
}

function isBearerType(t: CredentialType): t is BearerType {
  return t === 'rest' || t === 'mcp' || t === 'cli';
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
              receiver_id, display_name, legacy_username, status,
              rate_limit_per_min, created_at, last_used_at, last_used_ip,
              disabled_at, revoked_at
       FROM mailbox_credentials_v2
       WHERE mailbox_id = ?1
       ORDER BY created_at ASC`,
    )
      .bind(mailboxId)
      .all<CredentialRowV2>();
    return c.json({ data: rows.results.map(publicView) });
  },
);

// ---------------------------------------------------------------------------
// POST /v1/admin/mailboxes/:id/credentials — issue
// ---------------------------------------------------------------------------

interface IssueBodyNew {
  type?: CredentialType;
  display_name?: string;
  receiver_id?: string;
}
interface IssueBodyLegacy {
  protocol?: 'imap' | 'smtps';
  username?: string;
}
type IssueBody = IssueBodyNew & IssueBodyLegacy;

interface NormalisedIssueArgs {
  type: CredentialType;
  display_name: string | null;
  receiver_id: string | null;
  legacy_username: string | null;
}

function normaliseIssueBody(
  raw: IssueBody,
): { ok: true; args: NormalisedIssueArgs } | { ok: false; error: string } {
  // Legacy shape: `{ protocol, username }`. Translate before validation.
  if (!raw.type && raw.protocol) {
    const type: CredentialType = raw.protocol === 'smtps' ? 'smtp' : 'imap';
    return {
      ok: true,
      args: {
        type,
        display_name: raw.username ?? null,
        // legacy callers don't bind an IMAP receiver — operator
        // re-issues with the new shape if they want that binding
        receiver_id: null,
        legacy_username: raw.username ?? null,
      },
    };
  }
  // New shape.
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
      legacy_username: null,
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
    const { type, display_name, receiver_id, legacy_username } = norm.args;

    if (receiver_id && !(await receiverBelongsToMailbox(c.env, receiver_id, mailboxId))) {
      return buildError(c, 'bad_request', 'receiver_id does not belong to this mailbox');
    }

    const id = ulid();
    const secret = generateSecret();
    const secretHash = await hashForType(type, secret, c.env);
    const prefix = PREFIX_FOR_TYPE[type];
    const createdAt = new Date().toISOString();

    await c.env.DB.prepare(
      `INSERT INTO mailbox_credentials_v2
         (id, mailbox_id, type, prefix, secret_hash, receiver_id,
          display_name, legacy_username, status, rate_limit_per_min,
          created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'primary', 60, ?9)`,
    )
      .bind(
        id,
        mailboxId,
        type,
        prefix,
        secretHash,
        receiver_id,
        display_name,
        legacy_username,
        createdAt,
      )
      .run();

    // KV cache — `mc:` prefix namespaces these away from operator
    // (`plain:`/`key:`) + bridge (`bridge_plain:`) entries so a leaked
    // snapshot can't be mistaken across scopes. Plain cache window
    // matches the existing api_keys flow (15min).
    await c.env.KV_KEY_CACHE.put(`mc:plain:${id}`, secret, { expirationTtl: 15 * 60 });
    await c.env.KV_KEY_CACHE.put(
      `mc:row:${id}`,
      JSON.stringify({
        id,
        mailbox_id: mailboxId,
        type,
        prefix,
        receiver_id,
        secret_hash: secretHash,
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
      return c.json(
        {
          ...base,
          // New shape
          username: `${prefix}${id}`,
          password: secret,
          // Legacy shape — old callers reading these still work.
          protocol: type === 'smtp' ? 'smtps' : 'imap',
          auth_type: 'password' as const,
          plaintext: secret,
        },
        201,
      );
    }
    // Bearer types (rest/mcp/cli)
    return c.json(
      {
        ...base,
        // New shape
        key_id: id,
        key_secret: secret,
        bearer: formatBearer(type, id, secret),
        // Legacy shape (pk_live_ admin.ts response)
        plaintext: secret,
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
              receiver_id, display_name, legacy_username, status,
              rate_limit_per_min, created_at, last_used_at, last_used_ip,
              disabled_at, revoked_at
       FROM mailbox_credentials_v2 WHERE id = ?1 AND mailbox_id = ?2 LIMIT 1`,
    )
      .bind(credId, mailboxId)
      .first<CredentialRowV2>();
    if (!row) return buildError(c, 'not_found', 'credential not found');
    if (row.disabled_at) return buildError(c, 'conflict', 'credential disabled');
    if (row.revoked_at) return buildError(c, 'conflict', 'credential revoked');

    const newSecret = generateSecret();
    const newHash = await hashForType(row.type, newSecret, c.env);
    // Planned: shift current hash into secret_prev_hash for a grace
    // window so an in-flight client doesn't 401 mid-request. Emergency:
    // wipe the previous immediately.
    const prevHash = mode === 'planned' ? row.secret_hash : null;
    await c.env.DB.prepare(
      `UPDATE mailbox_credentials_v2
         SET secret_hash = ?1, secret_prev_hash = ?2
       WHERE id = ?3`,
    )
      .bind(newHash, prevHash, credId)
      .run();

    await c.env.KV_KEY_CACHE.put(`mc:plain:${credId}`, newSecret, { expirationTtl: 15 * 60 });
    await c.env.KV_KEY_CACHE.delete(`mc:row:${credId}`);

    await audit(c.env, {
      actor: actorOf(c),
      action: 'mailbox_credential.rotate',
      target: credId,
      meta: { mailbox_id: mailboxId, type: row.type, mode },
    });

    const response: Record<string, unknown> = {
      id: credId,
      mailbox_id: mailboxId,
      type: row.type,
      prefix: row.prefix,
      // Legacy field — old credentials-mailbox.ts callers read this.
      plaintext: newSecret,
    };
    if (row.type === 'imap' || row.type === 'smtp') {
      response.username = `${row.prefix}${credId}`;
      response.password = newSecret;
    } else if (isBearerType(row.type)) {
      response.key_id = credId;
      response.key_secret = newSecret;
      response.bearer = formatBearer(row.type, credId, newSecret);
    }
    return c.json(response);
  },
);

// ---------------------------------------------------------------------------
// DELETE /v1/admin/mailboxes/:id/credentials/:credId — revoke
// ---------------------------------------------------------------------------
// DELETE method matches the legacy shape in credentials-mailbox.ts and
// the panel's destructive-action flow. The row is preserved (soft
// delete) so audit + last-used history stays queryable.

mailboxCredentials.delete(
  '/v1/admin/mailboxes/:id/credentials/:credId',
  requireScope('admin:rotate'),
  async (c) => {
    const mailboxId = c.req.param('id');
    const credId = c.req.param('credId');
    const row = await c.env.DB.prepare(
      `SELECT id, type FROM mailbox_credentials_v2 WHERE id = ?1 AND mailbox_id = ?2 LIMIT 1`,
    )
      .bind(credId, mailboxId)
      .first<{ id: string; type: CredentialType }>();
    if (!row) return buildError(c, 'not_found', 'credential not found');

    const now = new Date().toISOString();
    await c.env.DB.prepare(
      `UPDATE mailbox_credentials_v2
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
