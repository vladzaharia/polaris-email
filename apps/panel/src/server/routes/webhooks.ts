import { Hono } from 'hono';
import type { Env } from '../env.js';
import { makePolaris } from '../polaris.js';

export const webhooksRoutes = new Hono<{ Bindings: Env }>();

webhooksRoutes.post('/api/webhook-subs', async (c) => {
  const body = await c.req.json();
  const r = await makePolaris(c.env).call('POST', '/v1/admin/webhook-subs', body);
  return c.json(r.body, r.status as 200 | 400);
});
