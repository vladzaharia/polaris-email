import { Hono } from 'hono';
import type { PolarisClient } from '../polaris.js';

export function webhooksRoutes(polaris: PolarisClient) {
  const app = new Hono();
  app.post('/api/webhook-subs', async (c) => {
    const body = await c.req.json();
    const r = await polaris.call('POST', '/v1/admin/webhook-subs', body);
    return c.json(r.body, r.status as 200 | 400);
  });
  return app;
}
