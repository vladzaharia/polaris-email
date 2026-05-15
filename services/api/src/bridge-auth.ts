// Bridge HMAC auth middleware for /v1/bridge/* (and historically /v1/send/raw).
//
// Distinct from tenant HMAC auth (auth.ts):
// - HMAC secret is the bridge's pre-shared key (Env.BRIDGE_HMAC_KEY).
// - Identity is bridge_id from X-Polaris-Bridge-Id.
// - Cloudflare Access service token (CF-Access-Client-Id +
//   CF-Access-Client-Secret) verified by Access in front of the Worker.
// - The polaris-api direction is the HMAC canonical-string prefix; secret
//   isolation provides cross-context separation since tenant API keys live
//   in api_keys rows and the bridge secret lives only in Workers Secrets.

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

    if (!env.BRIDGE_HMAC_KEY) {
      return buildError(c, 'unauthorized', 'bridge auth not configured on server');
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
      secret: env.BRIDGE_HMAC_KEY,
    });
    if (!result.ok) {
      return buildError(c, 'unauthorized', `bridge HMAC: ${result.code}`);
    }

    c.set('bridgeId', bridgeId);
    c.set('submissionId', submissionId);
    await next();
  };
}
