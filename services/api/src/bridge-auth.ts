// Bridge HMAC auth for /v1/messages (RFC822) + /v1/messages-state.
//
// Distinct from tenant HMAC auth (auth.ts):
// - Identity is bridge_id from X-Polaris-Bridge-Id.
// - HMAC secret is the per-bridge secret minted at registration (stored as
//   an argon2id hash in `bridges.hmac_key_secret_name` and cached in
//   plaintext in KV_KEY_CACHE under `bridge_plain:<bridge_id>` for verify).
// - Cloudflare Access service token (CF-Access-Client-Id +
//   CF-Access-Client-Secret) verified by Access in front of the Worker.
//
// Phase 2h:
//   * Removed the global Env.BRIDGE_HMAC_KEY shared key — it gave every
//     bridge the same secret and let one bridge impersonate any other.
//   * `lookupBridgeSecret()` is the single point for resolving the
//     verifying secret given a bridge_id; all three call sites
//     (routes/messages.ts, routes/messages-state.ts, the middleware here)
//     route through it.
//   * Plaintext is sourced from KV_KEY_CACHE; on cache miss we DO NOT
//     reload from D1 (the stored value is an argon2 hash and is one-way).
//     The operator must `polaris-email bridge rotate` to repopulate KV.
//     Pre-launch tradeoff: a global KV-cache flush implies a planned
//     rotation rather than a transparent re-derive. Documented here.

import type { MiddlewareHandler } from 'hono';
import { verify } from '@polaris-email/hmac';
import type { Env } from './env.js';
import { buildError } from './errors.js';

declare module 'hono' {
  interface ContextVariableMap {
    bridgeId: string;
    submissionId: string;
  }
}

/** KV key under which the plaintext per-bridge HMAC secret is cached. */
export function bridgePlainKvKey(bridgeId: string): string {
  return `bridge_plain:${bridgeId}`;
}

/** TTL for the plaintext cache. Matches the api-key plaintext TTL convention. */
export const BRIDGE_PLAIN_KV_TTL_SECONDS = 60 * 60;

export type BridgeSecretLookupOk = { ok: true; secret: string };
export type BridgeSecretLookupErr = {
  ok: false;
  code: 'unknown_bridge' | 'disabled' | 'key_propagating';
};
export type BridgeSecretLookup = BridgeSecretLookupOk | BridgeSecretLookupErr;

/**
 * Resolve the verifying HMAC secret for a bridge_id.
 *
 * Returns:
 *   - `{ ok: true, secret }` when the bridge exists, is not disabled, AND
 *     the plaintext is in KV.
 *   - `{ ok: false, code: 'unknown_bridge' }` when no row exists.
 *   - `{ ok: false, code: 'disabled' }` when the row's `disabled_at` is set.
 *   - `{ ok: false, code: 'key_propagating' }` when the row exists and is
 *     active but the plaintext is missing from KV. The stored argon2 hash
 *     can't be reversed, so the operator must rotate to repopulate KV.
 */
export async function lookupBridgeSecret(
  env: Env,
  bridgeId: string,
): Promise<BridgeSecretLookup> {
  const row = await env.DB.prepare(
    `SELECT id, disabled_at FROM bridges WHERE id = ? LIMIT 1`,
  )
    .bind(bridgeId)
    .first<{ id: string; disabled_at: string | null }>();
  if (!row) return { ok: false, code: 'unknown_bridge' };
  if (row.disabled_at != null) return { ok: false, code: 'disabled' };
  const plaintext = await env.KV_KEY_CACHE.get(bridgePlainKvKey(bridgeId));
  if (!plaintext) return { ok: false, code: 'key_propagating' };
  return { ok: true, secret: plaintext };
}

export function bridgeHmacAuth(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const env = c.env;
    const bridgeId = c.req.header('x-polaris-bridge-id');
    const submissionId = c.req.header('x-polaris-submission-id');
    if (!bridgeId) return buildError(c, 'unauthorized', 'X-Polaris-Bridge-Id required');
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(bridgeId)) {
      return buildError(c, 'unauthorized', 'invalid bridge_id format');
    }
    if (!submissionId || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(submissionId)) {
      return buildError(c, 'unauthorized', 'invalid submission_id format');
    }

    const lookup = await lookupBridgeSecret(env, bridgeId);
    if (!lookup.ok) {
      if (lookup.code === 'key_propagating') {
        return buildError(c, 'key_propagating', 'bridge plaintext not in cache; rotate to repopulate', {
          'retry-after': '2',
        });
      }
      // unknown_bridge / disabled both look like an unauthorized identity.
      return buildError(c, 'unauthorized', `bridge: ${lookup.code}`);
    }

    const bodyText = await c.req.text();
    (c.req as unknown as { _cachedBody: string })._cachedBody = bodyText;

    const url = new URL(c.req.url);
    const result = await verify({
      direction: 'polaris-api',
      method: c.req.method,
      path: url.pathname,
      query: url.search.slice(1),
      headers: {
        get(name: string) {
          return c.req.header(name) ?? null;
        },
      },
      body: bodyText,
      secret: lookup.secret,
    });
    if (!result.ok) {
      return buildError(c, 'unauthorized', `bridge HMAC: ${result.code}`);
    }

    c.set('bridgeId', bridgeId);
    c.set('submissionId', submissionId);
    await next();
  };
}
