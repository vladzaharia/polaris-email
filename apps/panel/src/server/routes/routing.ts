import { Hono } from 'hono';
import type { PolarisClient } from '../polaris.js';

export function routingRoutes(polaris: PolarisClient) {
  const app = new Hono();
  app.post('/api/routing-rules', async (c) => {
    const body = await c.req.json();
    const r = await polaris.call('POST', '/v1/admin/routing-rules', body);
    return c.json(r.body, r.status as 200 | 400);
  });
  app.post('/api/local-webhook-targets', async (c) => {
    const body = await c.req.json();
    const r = await polaris.call('POST', '/v1/admin/local-webhook-targets', body);
    return c.json(r.body, r.status as 200 | 400);
  });
  return app;
}
