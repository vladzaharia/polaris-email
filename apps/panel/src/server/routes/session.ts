// Thin /api/me + step-up + logout endpoints. The heavy lifting lives in
// better-auth's mounted handler at /api/auth/*; this file exposes the
// panel-friendly shape the React client expects.
import { Hono } from 'hono';
import type { Env } from '../env.js';
import { makeAuth } from '../auth/index.js';
import { issueStepUp } from '../auth/step-up.js';

export const sessionRoutes = new Hono<{ Bindings: Env }>();

sessionRoutes.get('/api/me', (c) => {
  const s = c.get('session');
  if (!s) return c.json({ authenticated: false }, 200);
  return c.json({
    authenticated: true,
    subject: s.userId,
    email: s.email,
    admin: s.admin,
  });
});

sessionRoutes.post('/api/logout', async (c) => {
  const auth = makeAuth(c.env);
  await auth.api.signOut({ headers: c.req.raw.headers });
  return c.json({ ok: true });
});

sessionRoutes.post('/api/step-up', async (c) => {
  const s = c.get('session');
  if (!s) return c.json({ error: 'unauthorized' }, 401);
  // In production the client first completes a fresh WebAuthn assertion via
  // better-auth's /api/auth/two-factor endpoints, then POSTs here to record
  // the elevation. The flow is intentionally trust-on-this-request — the
  // re-auth itself is the gate.
  const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
  const result = await issueStepUp(c, body.reason ?? 'manual', 5 * 60_000);
  return c.json(result);
});

// Dev-mode escape hatch: stamp a session as any subject without going
// through OIDC. Only enabled when env.DEV_MODE === '1'.
sessionRoutes.post('/api/dev/login', async (c) => {
  if (c.env.DEV_MODE !== '1') return c.json({ error: 'not_found' }, 404);
  const auth = makeAuth(c.env);
  const body = (await c.req.json()) as { email?: string; admin?: boolean };
  const email = body.email ?? 'dev@local';
  // Sign in via better-auth's email-only signUp/signIn path. The credentials
  // store is opt-in for dev; production should rely exclusively on SSO.
  const result = await auth.api.signInEmail({
    body: { email, password: 'dev-mode-password' },
    headers: c.req.raw.headers,
  });
  return c.json({ ok: true, user: result?.user, admin: body.admin ?? false });
});
