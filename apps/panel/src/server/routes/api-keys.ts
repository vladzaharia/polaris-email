import { Hono } from 'hono';
import type { Env } from '../env.js';
import { makePolaris } from '../polaris.js';

export const apiKeysRoutes = new Hono<{ Bindings: Env }>();

apiKeysRoutes.get('/api/api-keys', async (c) => {
  const service = c.req.query('service');
  const r = await makePolaris(c.env).call(
    'GET',
    '/v1/admin/api-keys',
    undefined,
    service ? `service=${encodeURIComponent(service)}` : '',
  );
  return c.json(r.body, r.status as 200 | 400);
});
apiKeysRoutes.post('/api/api-keys', async (c) => {
  const body = await c.req.json();
  const r = await makePolaris(c.env).call('POST', '/v1/admin/api-keys', body);
  return c.json(r.body, r.status as 200 | 400);
});
apiKeysRoutes.post('/api/api-keys/:id/rotate', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const r = await makePolaris(c.env).call('POST', `/v1/admin/api-keys/${id}/rotate`, body);
  return c.json(r.body, r.status as 200 | 400);
});
apiKeysRoutes.post('/api/api-keys/:id/revoke', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const r = await makePolaris(c.env).call('POST', `/v1/admin/api-keys/${id}/revoke`, body);
  return c.json(r.body, r.status as 200 | 400);
});
