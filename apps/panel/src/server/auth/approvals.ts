// Two-person approval flow.
//
// Endpoints:
//   POST /api/approvals               request — body { action, resource_id, payload }
//   GET  /api/approvals/pending       list pending requests visible to current admin
//   POST /api/approvals/:id/approve   approve (must be a different user than the requester)
//
// `withApproval(action)` is a middleware factory used by sensitive routes: it
// inspects `x-polaris-approval-id` on the request and verifies the matching
// row is `approved`, fresh, and signed off by a user *other than* the caller.
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { and, eq, gt } from 'drizzle-orm';
import type { Env } from '../env.js';
import { approvals } from './schema.js';

const APPROVAL_TTL_MS = 30 * 60_000;

export const approvalsRoutes = new Hono<{ Bindings: Env }>();

approvalsRoutes.post('/api/approvals', async (c) => {
  const sess = c.get('session');
  if (!sess) return c.json({ error: 'unauthorized' }, 401);
  const body = (await c.req.json()) as {
    action: string;
    resource_id: string;
    payload: unknown;
  };
  if (!body.action || !body.resource_id) {
    return c.json({ error: 'action_and_resource_id_required' }, 400);
  }
  const db = drizzle(c.env.DB);
  const now = Date.now();
  const id = crypto.randomUUID();
  await db.insert(approvals).values({
    id,
    requesterUserId: sess.userId,
    approverUserId: null,
    action: body.action,
    resourceId: body.resource_id,
    payload: JSON.stringify(body.payload ?? {}),
    status: 'pending',
    createdAt: new Date(now),
    decidedAt: null,
    expiresAt: new Date(now + APPROVAL_TTL_MS),
  });
  return c.json({ id, status: 'pending', expires_at: now + APPROVAL_TTL_MS }, 201);
});

approvalsRoutes.get('/api/approvals/pending', async (c) => {
  const sess = c.get('session');
  if (!sess) return c.json({ error: 'unauthorized' }, 401);
  if (!sess.admin) return c.json({ error: 'forbidden' }, 403);
  const db = drizzle(c.env.DB);
  const rows = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.status, 'pending'), gt(approvals.expiresAt, new Date())));
  return c.json({ data: rows });
});

approvalsRoutes.post('/api/approvals/:id/approve', async (c) => {
  const sess = c.get('session');
  if (!sess) return c.json({ error: 'unauthorized' }, 401);
  if (!sess.admin) return c.json({ error: 'forbidden' }, 403);
  const id = c.req.param('id');
  const db = drizzle(c.env.DB);
  const rows = await db.select().from(approvals).where(eq(approvals.id, id)).limit(1);
  const row = rows[0];
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (row.requesterUserId === sess.userId) {
    return c.json({ error: 'two_person_required', detail: 'cannot self-approve' }, 403);
  }
  if (row.status !== 'pending')
    return c.json({ error: 'already_decided', status: row.status }, 409);
  if (row.expiresAt.getTime() < Date.now()) {
    await db.update(approvals).set({ status: 'expired' }).where(eq(approvals.id, id));
    return c.json({ error: 'expired' }, 409);
  }
  await db
    .update(approvals)
    .set({ status: 'approved', approverUserId: sess.userId, decidedAt: new Date() })
    .where(eq(approvals.id, id));
  return c.json({ id, status: 'approved' });
});

// Middleware: gate a route on an approved approval-id. The client passes
// `x-polaris-approval-id`; we verify the approval is approved, fresh, matches
// the requested action, and that the approver is distinct from the caller.
export function withApproval(action: string): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const sess = c.get('session');
    if (!sess) return c.json({ error: 'unauthorized' }, 401);
    const approvalId = c.req.header('x-polaris-approval-id');
    if (!approvalId) {
      return c.json({ code: 'approval_required', action }, 428);
    }
    const db = drizzle(c.env.DB);
    const rows = await db.select().from(approvals).where(eq(approvals.id, approvalId)).limit(1);
    const row = rows[0];
    if (!row || row.action !== action) return c.json({ error: 'approval_invalid' }, 403);
    if (row.status !== 'approved') return c.json({ error: 'approval_not_approved' }, 403);
    if (!row.approverUserId || row.approverUserId === sess.userId) {
      return c.json({ error: 'two_person_required' }, 403);
    }
    if (row.expiresAt.getTime() < Date.now()) return c.json({ error: 'approval_expired' }, 403);
    await next();
  };
}
