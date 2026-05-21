// Admin credentials facade. Unions api_keys + submission_credentials so the
// CLI's `polaris-mail cred list|rotate|revoke` can operate on either kind
// without the operator caring.
import { Hono } from 'hono';
import { revoke } from '@polaris-mail/revocation';
import { actorOf, audit } from '../../audit.js';
import { requireScope } from '../../auth.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';

export const credentials = new Hono<{ Bindings: Env }>();

interface ApiKeyRow {
  id: string;
  principal_id: string;
  status: string;
  created_at: string;
}
interface SmtpCredRow {
  id: string;
  principal_id: string;
  username: string;
  created_at: string;
  disabled_at: string | null;
}
interface PrincipalRow {
  id: string;
  mailbox_id: string;
}

credentials.get('/v1/admin/credentials', requireScope('admin:read'), async (c) => {
  const mailbox = c.req.query('mailbox') ?? c.req.query('mailbox_id');
  if (!mailbox) return buildError(c, 'bad_request', 'mailbox required');
  // Two-step lookup (mock D1 doesn't parse joins).
  const principals = await c.env.DB.prepare(
    `SELECT id, mailbox_id FROM principals WHERE mailbox_id = ?`,
  )
    .bind(mailbox)
    .all<PrincipalRow>();
  if (principals.results.length === 0) return c.json({ data: [] });
  const data: {
    kind: 'api_key' | 'smtp';
    id: string;
    principal_id: string;
    status: string;
    created_at: string;
    username?: string;
  }[] = [];
  for (const p of principals.results) {
    const apiKeys = await c.env.DB.prepare(
      `SELECT id, principal_id, status, created_at FROM api_keys WHERE principal_id = ? ORDER BY created_at DESC`,
    )
      .bind(p.id)
      .all<ApiKeyRow>();
    for (const k of apiKeys.results) {
      data.push({
        kind: 'api_key',
        id: k.id,
        principal_id: k.principal_id,
        status: k.status,
        created_at: k.created_at,
      });
    }
    const smtps = await c.env.DB.prepare(
      `SELECT id, principal_id, username, created_at, disabled_at FROM submission_credentials WHERE principal_id = ?`,
    )
      .bind(p.id)
      .all<SmtpCredRow>();
    for (const s of smtps.results) {
      data.push({
        kind: 'smtp',
        id: s.id,
        principal_id: s.principal_id,
        status: s.disabled_at ? 'revoked' : 'active',
        created_at: s.created_at,
        username: s.username,
      });
    }
  }
  return c.json({ data });
});

async function resolveCredential(
  c: { env: Env },
  id: string,
): Promise<{ kind: 'api_key' | 'smtp'; principal_id: string } | null> {
  const ak = await c.env.DB.prepare(`SELECT principal_id FROM api_keys WHERE id = ?`)
    .bind(id)
    .first<{ principal_id: string }>();
  if (ak) return { kind: 'api_key', principal_id: ak.principal_id };
  const sc = await c.env.DB.prepare(`SELECT principal_id FROM submission_credentials WHERE id = ?`)
    .bind(id)
    .first<{ principal_id: string }>();
  if (sc) return { kind: 'smtp', principal_id: sc.principal_id };
  return null;
}

credentials.post('/v1/admin/credentials/:id/revoke', requireScope('admin:rotate'), async (c) => {
  const id = c.req.param('id');
  const resolved = await resolveCredential(c, id);
  if (!resolved) return buildError(c, 'not_found', 'credential not found');
  const nowIso = new Date().toISOString();
  const cacheKeysToBust: string[] = [];
  if (resolved.kind === 'api_key') {
    await c.env.DB.prepare(
      `UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE id = ? AND status <> 'revoked'`,
    )
      .bind(nowIso, id)
      .run();
    cacheKeysToBust.push(`plain:${id}`, `key:${id}`);
  } else {
    await c.env.DB.prepare(
      `UPDATE submission_credentials SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL`,
    )
      .bind(nowIso, id)
      .run();
  }
  // Phase 3g — `revoke()` now owns the KV_KEY_CACHE bust too. Stamps
  // KV_REVOCATIONS so the next POST /v1/messages (RFC822) and generic
  // HMAC auth both reject immediately, regardless of the kind (api key vs
  // submission cred) — both authenticate via principal_id.
  await revoke(c.env, resolved.principal_id, cacheKeysToBust);
  await audit(c.env, {
    actor: actorOf(c),
    action: resolved.kind === 'api_key' ? 'api_key.revoke' : 'smtp_credential.disable',
    target: id,
    meta: { principal_id: resolved.principal_id, via: 'credentials_facade' },
  });
  return c.json({ id, revoked_at: Date.now() });
});

credentials.post('/v1/admin/credentials/:id/rotate', requireScope('admin:rotate'), async (c) => {
  const id = c.req.param('id');
  const resolved = await resolveCredential(c, id);
  if (!resolved) return buildError(c, 'not_found', 'credential not found');
  // The kind-specific rotate logic lives in admin.ts (api-keys rotate) and
  // admin/senders.ts (smtp credentials are rotated by issuing a new one).
  // The facade only acks the request and tells the operator where to go
  // for the actual rotate flow.
  return c.json({
    id,
    kind: resolved.kind,
    message:
      resolved.kind === 'api_key'
        ? `use POST /v1/admin/api-keys/${id}/rotate to receive the new secret`
        : 'SMTP credentials rotate by issuing a new one via POST /v1/admin/senders/:senderId/smtp-credentials',
  });
});
