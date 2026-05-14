import { Hono } from 'hono';
import type { Env } from '../env.js';
import { makePolaris } from '../polaris.js';

export const auditRoutes = new Hono<{ Bindings: Env }>();

auditRoutes.get('/api/audit/chain-status', async (c) => {
  const r = await makePolaris(c.env).call('GET', '/v1/admin/audit/chain-status');
  return c.json(r.body, r.status as 200 | 400);
});
