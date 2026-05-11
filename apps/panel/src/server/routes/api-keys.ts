import { Hono } from 'hono';
import type { PolarisClient } from '../polaris.js';

export function apiKeysRoutes(polaris: PolarisClient) {
  const app = new Hono();
  app.get('/api/api-keys', async (c) => {
    const service = c.req.query('service');
    const r = await polaris.call(
      'GET',
      '/v1/admin/api-keys',
      undefined,
      service ? `service=${encodeURIComponent(service)}` : '',
    );
    return c.json(r.body, r.status as 200 | 400);
  });
  app.post('/api/api-keys', async (c) => {
    const body = await c.req.json();
    const r = await polaris.call('POST', '/v1/admin/api-keys', body);
    return c.json(r.body, r.status as 200 | 400);
  });
  app.post('/api/api-keys/:id/rotate', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    const r = await polaris.call('POST', `/v1/admin/api-keys/${id}/rotate`, body);
    return c.json(r.body, r.status as 200 | 400);
  });
  app.post('/api/api-keys/:id/revoke', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    const r = await polaris.call('POST', `/v1/admin/api-keys/${id}/revoke`, body);
    return c.json(r.body, r.status as 200 | 400);
  });
  return app;
}
