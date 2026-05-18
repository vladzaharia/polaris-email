// Session + admin middleware for the panel.
//
// `sessionMiddleware()` reads better-auth's session cookie and stamps the
// resolved subject onto `c.var.session` for downstream handlers. The session
// shape (`PanelSession`) is intentionally narrow — userId, email, admin
// because that's all the panel routes ever need.
//
// `requireAuth()` and `requireAdmin()` are the two coarse gates we layer on
// top: any authenticated user vs. an authenticated user with the OIDC-synced
// `admin` flag set. Destructive actions (credential rotate/revoke, bridge
// rotate, DKIM rotate, mailbox/receiver delete, webhook DLQ drop, …) are
// gated client-side via `DestructiveActionDialog` (type-the-resource-name
// confirmation); every mutation writes an audit_log row whose row_hash
// chains to the previous row so any rewrite breaks the chain.
import type { MiddlewareHandler } from 'hono';
import type { Env } from '../env.js';
import { makeAuth } from './index.js';

export interface PanelSession {
  userId: string;
  email: string;
  admin: boolean;
}

declare module 'hono' {
  interface ContextVariableMap {
    session?: PanelSession;
  }
}

// Read the current panel session via better-auth. Sets `c.var.session` if a
// valid auth cookie is present.
export function sessionMiddleware(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const auth = makeAuth(c.env);
    const result = await auth.api.getSession({ headers: c.req.raw.headers });
    if (result?.user) {
      c.set('session', {
        userId: result.user.id,
        email: result.user.email,
        admin: Boolean((result.user as { admin?: boolean }).admin),
      });
    }
    await next();
  };
}

export function requireAuth(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    if (!c.get('session')) return c.json({ error: 'unauthorized' }, 401);
    await next();
  };
}

export function requireAdmin(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const s = c.get('session');
    if (!s) return c.json({ error: 'unauthorized' }, 401);
    if (!s.admin) return c.json({ error: 'forbidden' }, 403);
    await next();
  };
}
