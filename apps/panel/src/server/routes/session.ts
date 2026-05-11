// Dev login + step-up + approver-pairing for 2-person flows.
// In production the panel boots with OIDC config and DEV_MODE absent; the dev login is
// gated on DEV_MODE=1.
import { Hono } from 'hono';
import type { Database } from 'better-sqlite3';
import { deleteSession, putSession } from '../db.js';
import { SESSION_COOKIE } from '../auth.js';

function newSessionId(): string {
  const r = new Uint8Array(24);
  crypto.getRandomValues(r);
  return Array.from(r, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function sessionRoutes(db: Database, opts: { adminGroup: string; devMode: boolean }) {
  const app = new Hono();
  app.get('/api/me', (c) => {
    const s = c.get('session');
    if (!s) return c.json({ authenticated: false }, 200);
    return c.json({
      authenticated: true,
      subject: s.subject,
      email: s.email,
      display_name: s.display_name,
      groups: JSON.parse(s.groups_json),
      step_up_until: s.step_up_until,
      approver_subject: s.approver_subject,
    });
  });
  app.post('/api/logout', (c) => {
    const s = c.get('session');
    if (s) deleteSession(db, s.id);
    c.header('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return c.json({ ok: true });
  });
  // Step-up: marks the current session as step-up-validated for 5 min.
  // Real implementation would verify a fresh WebAuthn assertion here.
  app.post('/api/step-up', (c) => {
    const s = c.get('session');
    if (!s) return c.json({ error: 'unauthorized' }, 401);
    s.step_up_until = Date.now() + 5 * 60_000;
    putSession(db, s);
    return c.json({ ok: true, expires_at: s.step_up_until });
  });
  app.post('/api/approver', async (c) => {
    const s = c.get('session');
    if (!s) return c.json({ error: 'unauthorized' }, 401);
    const body = (await c.req.json()) as { approver_subject: string };
    if (!body.approver_subject || body.approver_subject === s.subject) {
      return c.json({ error: 'two_person_required' }, 400);
    }
    s.approver_subject = body.approver_subject;
    putSession(db, s);
    return c.json({ ok: true });
  });
  // Dev login — DEV_MODE only.
  if (opts.devMode) {
    app.post('/api/dev/login', async (c) => {
      const body = (await c.req.json()) as { subject?: string; admin?: boolean };
      const sid = newSessionId();
      const now = Date.now();
      putSession(db, {
        id: sid,
        subject: body.subject ?? 'dev@local',
        email: body.subject ?? 'dev@local',
        display_name: 'Dev User',
        groups_json: JSON.stringify(body.admin ? [opts.adminGroup] : []),
        created_at: now,
        expires_at: now + 8 * 60 * 60 * 1000,
        step_up_until: null,
        approver_subject: null,
      });
      c.header(
        'set-cookie',
        `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${8 * 60 * 60}`,
      );
      return c.json({ ok: true });
    });
  }
  return app;
}
