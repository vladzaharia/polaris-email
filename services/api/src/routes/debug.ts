// Debug routes — gated on `env.DEV_MODE === '1'`.
//
// Today the only consumer is /v1/debug/whoami, which lets us smoke the
// mailbox-credential Bearer verifier end-to-end without yet wiring a
// real MCP/CLI consumer endpoint. Operators issue a credential, hit
// this endpoint with the bearer string, and confirm the verifier
// resolves to the correct mailbox + type.
//
// In production deployments DEV_MODE is unset and the handler responds
// 404 — same shape as a never-defined route, no side-channel that
// DEV_MODE exists at all.
import { Hono } from 'hono';
import type { Env } from '../env.js';
import { buildError } from '../errors.js';
import { bearerAuth } from '../lib/mailbox-cred-auth.js';

export const debugRoutes = new Hono<{ Bindings: Env }>();

// Gate the entire module on DEV_MODE so production deploys don't even
// match these paths. Hono matches first-wins; a non-DEV deploy falls
// through to the global notFound handler.
debugRoutes.use('/v1/debug/*', async (c, next) => {
  if (c.env.DEV_MODE !== '1') return buildError(c, 'not_found', 'route not enabled');
  return next();
});

debugRoutes.get('/v1/debug/whoami', bearerAuth({ allowTypes: ['rest', 'mcp', 'cli'] }), (c) => {
  const cred = c.get('mailboxCredential');
  if (!cred) {
    // Should be unreachable — bearerAuth would have 401'd already.
    return buildError(c, 'unauthorized', 'no credential bound to request');
  }
  return c.json({
    id: cred.id,
    mailbox_id: cred.mailbox_id,
    type: cred.type,
    prefix: cred.prefix,
    receiver_id: cred.receiver_id,
  });
});
