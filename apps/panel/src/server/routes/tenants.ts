import { Hono } from 'hono';
import type { PolarisClient } from '../polaris.js';

export function tenantsRoutes(polaris: PolarisClient) {
  const app = new Hono();
  app.get('/api/tenants', async (c) => {
    const r = await polaris.call('GET', '/v1/admin/tenants');
    return c.json(r.body, r.status as 200 | 400);
  });
  app.post('/api/tenants', async (c) => {
    const body = await c.req.json();
    const r = await polaris.call('POST', '/v1/admin/tenants', body);
    return c.json(r.body, r.status as 200 | 400);
  });
  app.post('/api/tenants/:id/quarantine', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    const r = await polaris.call('POST', '/v1/admin/bulk/revoke-tenant', {
      tenant_id: id,
      mode: 'emergency',
      confirmation: id,
      incident_ticket_id: body.incident_ticket_id,
    });
    return c.json(r.body, r.status as 200 | 400);
  });
  return app;
}
