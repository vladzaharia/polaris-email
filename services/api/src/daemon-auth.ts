// Daemon HMAC auth middleware for /v1/daemon/* and /v1/send/raw.
//
// Distinct from tenant HMAC auth (auth.ts):
// - HMAC secret is the daemon's pre-shared key (Env.DAEMON_HMAC_KEY for v1;
//   per-daemon secret in v1.x once the daemons table is wired).
// - Identity is daemon_id from X-Polaris-Daemon-Id.
// - Cloudflare Access service token (CF-Access-Client-Id +
//   CF-Access-Client-Secret) verified by Access in front of the Worker (I18).
// - We use the polaris-api.v1 direction (existing scheme); secret isolation
//   provides cross-context separation since tenant API keys live in api_keys
//   rows and the daemon secret lives only in Workers Secrets.

import type { MiddlewareHandler } from 'hono';
import { verify } from '@polaris-email/hmac';
import type { Env } from './env.js';
import { buildError } from './errors.js';

declare module 'hono' {
  interface ContextVariableMap {
    daemonId: string;
    submissionId: string;
  }
}

export function daemonHmacAuth(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const env = c.env;
    const daemonId = c.req.header('x-polaris-daemon-id');
    const submissionId = c.req.header('x-polaris-submission-id');
    if (!daemonId) return buildError(c, 'unauthorized', 'X-Polaris-Daemon-Id required');
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(daemonId)) {
      return buildError(c, 'unauthorized', 'invalid daemon_id format');
    }
    if (!submissionId || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(submissionId)) {
      return buildError(c, 'unauthorized', 'invalid submission_id format');
    }

    if (!env.DAEMON_HMAC_KEY) {
      return buildError(c, 'unauthorized', 'daemon auth not configured on server');
    }

    const bodyText = await c.req.text();
    (c.req as unknown as { _cachedBody: string })._cachedBody = bodyText;

    const url = new URL(c.req.url);
    const result = await verify({
      direction: 'polaris-api.v1',
      method: c.req.method,
      path: url.pathname,
      query: url.search.slice(1),
      headers: {
        get(name: string) {
          return c.req.header(name) ?? null;
        },
      },
      body: bodyText,
      secret: env.DAEMON_HMAC_KEY,
    });
    if (!result.ok) {
      return buildError(c, 'unauthorized', `daemon HMAC: ${result.code}`);
    }

    c.set('daemonId', daemonId);
    c.set('submissionId', submissionId);
    await next();
  };
}
