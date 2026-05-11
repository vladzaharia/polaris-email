import { Hono } from 'hono';
import type { PolarisClient } from '../polaris.js';

export function mailboxesRoutes(polaris: PolarisClient) {
  const app = new Hono();
  app.post('/api/mailboxes', async (c) => {
    const body = await c.req.json();
    const r = await polaris.call('POST', '/v1/admin/mailboxes', body);
    return c.json(r.body, r.status as 200 | 400);
  });
  app.post('/api/mailboxes/:id/imap-credential/rotate', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    const r = await polaris.call(
      'POST',
      `/v1/admin/mailboxes/${id}/imap-credential/rotate`,
      body,
    );
    return c.json(r.body, r.status as 200 | 400);
  });
  return app;
}
