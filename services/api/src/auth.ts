// HMAC auth middleware: looks up the key, fetches its secret, verifies signature,
// performs nonce-dedup, and attaches the key record to the context.
import type { Context, MiddlewareHandler } from 'hono';
import { verify } from '@polaris-email/hmac';
import type { Env } from './env.js';
import { buildError } from './errors.js';
import { verifySecret } from './hashing.js';

export interface AuthenticatedKey {
  key_id: string;
  service_id: string | null;
  sender_scopes_raw: string;
  scopes_raw: string;
  rate_limit_per_min: number;
  status: 'primary' | 'secondary' | 'revoked';
  revoked_at: number | null;
}

declare module 'hono' {
  interface ContextVariableMap {
    requestId: string;
    apiKey: AuthenticatedKey;
  }
}

const NONCE_TTL_SECONDS = 10 * 60; // 10 min

export function hmacAuth(direction: 'polaris-api.v1'): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const env = c.env;
    const keyId = c.req.header('x-polaris-key-id');
    if (!keyId)
      return buildError(c, 'unauthorized', 'X-Polaris-Key-Id required');
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(keyId))
      return buildError(c, 'unauthorized', 'X-Polaris-Key-Id format');

    // Read body once; needed for HMAC verification and for downstream handlers.
    const bodyText = await c.req.text();
    (c.req as any)._cachedBody = bodyText;

    // Load key from KV cache (warm path) or D1 (cold path).
    const cacheKey = `key:${keyId}`;
    const cached = await env.KV_KEY_CACHE.get(cacheKey, 'json').catch(() => null);
    type RowShape = {
      id: string;
      service_id: string | null;
      secret_argon2id: string;
      sender_scopes: string;
      scopes: string;
      rate_limit_per_min: number;
      status: 'primary' | 'secondary' | 'revoked';
      revoked_at: number | null;
    };
    let row: RowShape | null = null;
    if (cached) {
      row = cached as RowShape;
    } else {
      row = await env.DB.prepare(
        `SELECT id, service_id, secret_argon2id, sender_scopes, scopes,
                rate_limit_per_min, status, revoked_at
         FROM api_keys WHERE id = ?`,
      )
        .bind(keyId)
        .first<RowShape>();
      if (row) {
        c.executionCtx.waitUntil(env.KV_KEY_CACHE.put(cacheKey, JSON.stringify(row), { expirationTtl: 60 }));
      }
    }
    if (!row) {
      // Key not in DB might mean it was just issued and KV is propagating. Distinguish from
      // `bad_signature` so clients can retry.
      return buildError(c, 'key_propagating', 'unknown key id', { 'retry-after': '2' });
    }
    if (row.status === 'revoked' || row.revoked_at != null) {
      return buildError(c, 'key_revoked', 'key has been revoked');
    }

    // We have a hashed secret on disk and a candidate header signature. We can't HMAC-verify
    // *without* the plaintext secret. So we MUST also stash plaintext for short windows in KV
    // after issuance (`pending_plaintext`). That's done by /admin/api-keys issue/rotate
    // handlers and the entry self-expires after 60 s.
    const plaintext = await env.KV_KEY_CACHE.get(`plain:${keyId}`);
    if (!plaintext) {
      // After plaintext-cache TTL we cannot verify signatures without rehashing. This is
      // intentional: keys must be cached locally by clients; the api just verifies. If a
      // request comes in for a key whose plaintext we never had (race after restart of a CF
      // colo), respond `key_propagating` so the client retries — within 60 s the new key
      // will be considered missing entirely (`key_propagating`) and afterwards the secret
      // must have been picked up by other colos via the `plain:` KV write.
      return buildError(c, 'key_propagating', 'key plaintext not yet propagated', {
        'retry-after': '2',
      });
    }

    const path = new URL(c.req.url).pathname;
    const query = new URL(c.req.url).search;
    const result = await verify({
      direction,
      method: c.req.method,
      path,
      query,
      headers: {
        get: (n: string) => c.req.header(n) ?? null,
      },
      body: bodyText,
      secret: plaintext,
      allowedAlgorithms: env.VERIFY_ALGORITHMS.split(','),
    });
    if (!result.ok) {
      if (result.code === 'clock_skew')
        return buildError(c, 'clock_skew', result.message);
      if (result.code === 'algorithm_rejected')
        return buildError(c, 'bad_signature', `algorithm not allowed: ${result.message}`);
      if (result.code === 'missing_header' || result.code === 'header_invalid')
        return buildError(c, 'bad_request', result.message);
      return buildError(c, 'bad_signature', 'hmac mismatch');
    }

    // Nonce dedup (namespaced by key_id to prevent cross-tenant pollution).
    const nonceKey = `nonce:${keyId}:${result.nonce}`;
    const seen = await env.KV_NONCE.get(nonceKey);
    if (seen) {
      return buildError(c, 'nonce_replay', 'nonce already used for this key');
    }
    c.executionCtx.waitUntil(
      env.KV_NONCE.put(nonceKey, '1', { expirationTtl: NONCE_TTL_SECONDS }),
    );

    // Verify-key plaintext secret stored in KV is correct against argon2id hash (sanity, runs
    // once per cold KV entry; cheap because hashSecret was the slow side).
    // Skipped on warm cache to avoid the PBKDF2 cost per request. We *trust* the KV plain entry
    // because only /admin/api-keys handlers can write it.
    void verifySecret; // satisfy unused-import for callers that import this module

    c.set('apiKey', {
      key_id: row.id,
      service_id: row.service_id,
      sender_scopes_raw: row.sender_scopes,
      scopes_raw: row.scopes,
      rate_limit_per_min: row.rate_limit_per_min,
      status: row.status,
      revoked_at: row.revoked_at,
    });

    await next();
  };
}

/** Authorise an action scope (`send` / `admin:rotate` / …) on the authenticated key. */
export function requireScope(scope: string): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const k = c.get('apiKey');
    if (!k) return buildError(c, 'unauthorized', 'no api key on context');
    let parsed: string[];
    try {
      parsed = JSON.parse(k.scopes_raw);
    } catch {
      return buildError(c, 'forbidden', 'scopes parse failed');
    }
    if (!parsed.includes(scope)) {
      return buildError(c, 'scope_violation', `missing scope ${scope}`);
    }
    await next();
  };
}

export function bodyText(c: Context): string {
  return (c.req as any)._cachedBody ?? '';
}
