import { Hono } from 'hono';
import type { PolarisClient } from '../polaris.js';

export function auditRoutes(polaris: PolarisClient) {
  const app = new Hono();
  app.get('/api/audit/chain-status', async (c) => {
    const r = await polaris.call('GET', '/v1/admin/audit/chain-status');
    return c.json(r.body, r.status as 200 | 400);
  });
  return app;
}
