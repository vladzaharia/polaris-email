import { Hono } from 'hono';
import type { Env } from '../env.js';
import { makePolaris } from '../polaris.js';

export const routingRoutes = new Hono<{ Bindings: Env }>();

routingRoutes.post('/api/routing-rules', async (c) => {
  const body = await c.req.json();
  const r = await makePolaris(c.env).call('POST', '/v1/admin/routing-rules', body);
  return c.json(r.body, r.status as 200 | 400);
});
