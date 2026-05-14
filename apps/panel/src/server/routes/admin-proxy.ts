// Generic /api/admin/* passthrough to services/api over the API service
// binding. Panel pages call this surface; the polaris SDK adapter
// (server/polaris.ts) injects HMAC if PANEL_ADMIN_KEY_* are set, otherwise the
// service binding alone authenticates.
//
// The proxy preserves query string + method + JSON body, and surfaces the
// downstream status code verbatim so step-up / 428 errors flow through.
import { Hono } from 'hono';
import type { Env } from '../env.js';
import { makePolaris } from '../polaris.js';

export const adminProxyRoutes = new Hono<{ Bindings: Env }>();

// Catch-all under /api/admin: rewrites to /v1/admin/* on services/api.
adminProxyRoutes.all('/api/admin/*', async (c) => {
  const url = new URL(c.req.url);
  const upstream = url.pathname.replace(/^\/api\/admin/, '/v1/admin');
  const query = url.searchParams.toString();
  const method = c.req.method.toUpperCase();
  const body =
    method === 'GET' || method === 'HEAD' || method === 'DELETE'
      ? undefined
      : await c.req.json().catch(() => ({}));
  const r = await makePolaris(c.env).call(method, upstream, body, query || undefined);
  return c.json(r.body as Record<string, unknown>, r.status as 200 | 400);
});

// Panel /api/messages/* mirrors GET /v1/messages and GET /v1/messages/:id with
// the admin operator key (the SDK adapter handles auth). Attachment downloads
// stream straight from services/api via a raw fetch (no JSON wrapping).
adminProxyRoutes.get('/api/messages', async (c) => {
  const url = new URL(c.req.url);
  const r = await makePolaris(c.env).call(
    'GET',
    '/v1/messages',
    undefined,
    url.searchParams.toString() || undefined,
  );
  return c.json(r.body as Record<string, unknown>, r.status as 200 | 400);
});

adminProxyRoutes.get('/api/messages/:id', async (c) => {
  const id = c.req.param('id');
  const r = await makePolaris(c.env).call('GET', `/v1/messages/${id}`);
  return c.json(r.body as Record<string, unknown>, r.status as 200 | 400);
});

adminProxyRoutes.get('/api/messages/:id/attachments/:n', async (c) => {
  const id = c.req.param('id');
  const n = c.req.param('n');
  // TODO: replace with generated hook — surfaces a hint pointer to the signed
  // download URL once the SDK exposes a typed signed-URL mint helper.
  return c.json({
    href: `/api/messages/${id}/attachments/${n}/download`,
    upstream: `/v1/messages/${id}/attachments/${n}`,
  });
});
