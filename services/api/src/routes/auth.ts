// CLI session auth: `/v1/auth/login` and `/v1/auth/logout`.
//
// The login flow takes the operator's bearer token (the same api_key_secret
// returned by `POST /v1/admin/operators`) and round-trips it for validation
// before the CLI caches it in the OS keychain. Because the bearer IS the
// HMAC-signing credential, the hmacAuth middleware does the cryptographic
// work for us — this route only enforces two additional rules:
//
//   1. The api_key MUST be linked to an `operators` row. Bootstrap keys
//      (no operator) are explicitly rejected with `not_an_operator_token`
//      so the unified CLI auth flow can never accept a root credential.
//   2. On success, an `auth.login` row is written so admins can audit who
//      activated CLI access from where.
//
// Logout is a thin audit-only endpoint: it doesn't invalidate anything
// server-side (revocation is a separate admin action); it just lets the
// CLI write the corresponding `auth.logout` row when the operator runs
// `polaris-email logout`.
import { Hono } from 'hono';
import { actorOf, audit } from '../audit.js';
import { hmacAuth } from '../auth.js';
import type { Env } from '../env.js';
import { buildError } from '../errors.js';

export const auth = new Hono<{ Bindings: Env }>();

auth.use('/v1/auth/*', hmacAuth('polaris-api'));

auth.post('/v1/auth/login', async (c) => {
  const apiKey = c.get('apiKey');
  if (!apiKey) return buildError(c, 'unauthorized', 'auth middleware did not bind apiKey');
  const op = await c.env.DB.prepare(
    `SELECT id, name, email, role, disabled_at FROM operators WHERE api_key_id = ?`,
  )
    .bind(apiKey.key_id)
    .first<{
      id: string;
      name: string;
      email: string;
      role: 'admin' | 'operator' | 'readonly';
      disabled_at: string | null;
    }>();
  if (!op) {
    return buildError(
      c,
      'forbidden',
      'not_an_operator_token: this api_key is not linked to an operator',
      { 'x-polaris-reason': 'not_an_operator_token' },
    );
  }
  if (op.disabled_at) {
    return buildError(c, 'key_revoked', 'operator disabled');
  }
  await audit(c.env, {
    actor: actorOf(c),
    action: 'auth.login',
    target: op.id,
    meta: {
      api_key_id: apiKey.key_id,
      remote_ip: c.req.header('cf-connecting-ip') ?? null,
      user_agent: c.req.header('user-agent') ?? null,
    },
  });
  c.executionCtx.waitUntil(
    c.env.DB.prepare(`UPDATE operators SET last_seen_at = ? WHERE id = ?`)
      .bind(new Date().toISOString(), op.id)
      .run()
      .catch(() => undefined),
  );
  return c.json({
    operator: {
      id: op.id,
      name: op.name,
      email: op.email,
      role: op.role,
      api_key_id: apiKey.key_id,
    },
  });
});

auth.post('/v1/auth/logout', async (c) => {
  const apiKey = c.get('apiKey');
  if (!apiKey) return buildError(c, 'unauthorized', 'auth middleware did not bind apiKey');
  const op = await c.env.DB.prepare(`SELECT id FROM operators WHERE api_key_id = ?`)
    .bind(apiKey.key_id)
    .first<{ id: string }>();
  if (op) {
    await audit(c.env, {
      actor: actorOf(c),
      action: 'auth.logout',
      target: op.id,
      meta: {
        api_key_id: apiKey.key_id,
        remote_ip: c.req.header('cf-connecting-ip') ?? null,
      },
    });
  }
  return c.json({ ok: true });
});
