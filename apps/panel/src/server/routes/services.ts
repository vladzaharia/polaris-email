import { Hono } from 'hono';
import type { PolarisClient } from '../polaris.js';

export function servicesRoutes(polaris: PolarisClient) {
  const app = new Hono();
  app.get('/api/services', async (c) => {
    const r = await polaris.call('GET', '/v1/admin/services');
    return c.json(r.body, r.status as 200 | 400);
  });
  app.post('/api/services', async (c) => {
    const body = await c.req.json();
    const r = await polaris.call('POST', '/v1/admin/services', body);
    return c.json(r.body, r.status as 200 | 400);
  });
  app.post('/api/services/:id/quarantine', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    const r = await polaris.call('POST', '/v1/admin/bulk/revoke-service', {
      service_id: id,
      mode: 'emergency',
      confirmation: id,
      incident_ticket_id: body.incident_ticket_id,
    });
    return c.json(r.body, r.status as 200 | 400);
  });
  return app;
}
