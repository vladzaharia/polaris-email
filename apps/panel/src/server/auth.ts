// Middleware: cookie-based session lookup → context. requireAdmin gates panel write routes.
import type { MiddlewareHandler } from 'hono';
import type { Database } from 'better-sqlite3';
import { getSession, type SessionRow } from './db.js';

declare module 'hono' {
  interface ContextVariableMap {
    session?: SessionRow;
  }
}

const COOKIE_NAME = 'polaris_session';

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

export function sessionMiddleware(db: Database): MiddlewareHandler {
  return async (c, next) => {
    const sid = readCookie(c.req.header('cookie'), COOKIE_NAME);
    if (sid) {
      const row = getSession(db, sid);
      if (row) c.set('session', row);
    }
    await next();
  };
}

export function requireAuth(): MiddlewareHandler {
  return async (c, next) => {
    if (!c.get('session')) return c.json({ error: 'unauthorized' }, 401);
    await next();
  };
}

export function requireAdmin(adminGroup: string): MiddlewareHandler {
  return async (c, next) => {
    const s = c.get('session');
    if (!s) return c.json({ error: 'unauthorized' }, 401);
    let groups: string[];
    try {
      groups = JSON.parse(s.groups_json);
    } catch {
      return c.json({ error: 'forbidden' }, 403);
    }
    if (!groups.includes(adminGroup)) return c.json({ error: 'forbidden' }, 403);
    await next();
  };
}

export function requireStepUp(): MiddlewareHandler {
  return async (c, next) => {
    const s = c.get('session');
    if (!s) return c.json({ error: 'unauthorized' }, 401);
    if (!s.step_up_until || s.step_up_until < Date.now()) {
      return c.json({ error: 'step_up_required' }, 403);
    }
    await next();
  };
}

export function requireApproverDistinct(): MiddlewareHandler {
  return async (c, next) => {
    const s = c.get('session');
    if (!s) return c.json({ error: 'unauthorized' }, 401);
    if (!s.approver_subject || s.approver_subject === s.subject) {
      return c.json({ error: 'two_person_required' }, 403);
    }
    await next();
  };
}

export const SESSION_COOKIE = COOKIE_NAME;
