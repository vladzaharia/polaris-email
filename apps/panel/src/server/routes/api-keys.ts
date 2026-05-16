// Admin API-key management surface.
//
// `rotate` and `revoke` are destructive (the previous secret is invalidated
// immediately and any service signing requests with it starts seeing 401s),
// so both sit behind `withApproval(action)` — a second admin must approve
// the operation before the panel forwards it to services/api.
import { Hono } from 'hono';
import type { Env } from '../env.js';
import { makePolaris } from '../polaris.js';
import { withApproval } from '../auth/approvals.js';

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
apiKeysRoutes.post('/api/api-keys/:id/rotate', withApproval('api_key.rotate'), async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const r = await makePolaris(c.env).call('POST', `/v1/admin/api-keys/${id}/rotate`, body);
  return c.json(r.body, r.status as 200 | 400);
});
apiKeysRoutes.post('/api/api-keys/:id/revoke', withApproval('api_key.revoke'), async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const r = await makePolaris(c.env).call('POST', `/v1/admin/api-keys/${id}/revoke`, body);
  return c.json(r.body, r.status as 200 | 400);
});
