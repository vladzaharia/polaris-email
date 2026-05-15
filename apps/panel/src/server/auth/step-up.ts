// Step-up middleware.
//
// Sensitive endpoints (admin api_key rotate/revoke, bridge rotate, tenant
// quarantine) require a fresh step-up token. We read from the `step_ups`
// D1 table and check that an unexpired row exists for the current user.
//
// On miss the middleware returns 428 Precondition Required with a JSON body
// the client can read to escalate via the StepUpModal:
//   { code: 'step_up_required', step_up_url: '/panel/api/step-up' }
import type { Context, MiddlewareHandler } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { and, eq, gt } from 'drizzle-orm';
import type { Env } from '../env.js';
import { stepUps } from './schema.js';
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

export function stepUpMiddleware(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const sess = c.get('session');
    if (!sess) return c.json({ error: 'unauthorized' }, 401);
    const db = drizzle(c.env.DB);
    const now = new Date();
    const rows = await db
      .select({ id: stepUps.id })
      .from(stepUps)
      .where(and(eq(stepUps.userId, sess.userId), gt(stepUps.expiresAt, now)))
      .limit(1);
    if (rows.length === 0) {
      return c.json(
        {
          code: 'step_up_required',
          step_up_url: `${c.env.COOKIE_PATH || '/panel'}/api/step-up`,
        },
        428,
      );
    }
    await next();
  };
}

// Issue a step-up: called after a fresh re-auth (WebAuthn assertion, password
// recheck, etc.). The actual re-auth is performed by better-auth; this just
// records the elevation.
export async function issueStepUp(
  c: Context<{ Bindings: Env }>,
  reason: string,
  ttlMs = 5 * 60_000,
): Promise<{ ok: true; expiresAt: number }> {
  const sess = c.get('session');
  if (!sess) throw new Error('issueStepUp called without session');
  const db = drizzle(c.env.DB);
  const now = Date.now();
  const expiresAt = now + ttlMs;
  await db.insert(stepUps).values({
    id: crypto.randomUUID(),
    userId: sess.userId,
    reason,
    createdAt: new Date(now),
    expiresAt: new Date(expiresAt),
  });
  return { ok: true, expiresAt };
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
