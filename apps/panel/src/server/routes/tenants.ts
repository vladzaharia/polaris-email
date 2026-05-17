// Tenant management surface. `quarantine` is the emergency revoke path
// it asks services/api to revoke every credential for a tenant in one shot.
// Panel UI gates it client-side via `DestructiveActionDialog`; the audit_log
// chain captures the request.
import { Hono } from 'hono';
import type { Env } from '../env.js';
import { makePolaris } from '../polaris.js';

export const tenantsRoutes = new Hono<{ Bindings: Env }>();

tenantsRoutes.get('/api/tenants', async (c) => {
  const r = await makePolaris(c.env).call('GET', '/v1/admin/tenants');
  return c.json(r.body, r.status as 200 | 400);
});
tenantsRoutes.post('/api/tenants', async (c) => {
  const body = await c.req.json();
  const r = await makePolaris(c.env).call('POST', '/v1/admin/tenants', body);
  return c.json(r.body, r.status as 200 | 400);
});
tenantsRoutes.post('/api/tenants/:id/quarantine', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const r = await makePolaris(c.env).call('POST', '/v1/admin/bulk/revoke-tenant', {
    tenant_id: id,
    mode: 'emergency',
    confirmation: id,
    incident_ticket_id: body.incident_ticket_id,
  });
  return c.json(r.body, r.status as 200 | 400);
});
