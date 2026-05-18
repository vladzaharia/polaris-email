// Generic /api/admin/* passthrough to services/api over the API service
// binding. Panel pages call this surface; the polaris SDK adapter
// (server/polaris.ts) injects HMAC if PANEL_ADMIN_KEY_* are set, otherwise the
// service binding alone authenticates.
//
// The proxy preserves query string + method + JSON body, and surfaces the
// downstream status code verbatim. Destructive actions are gated client-side
// by `DestructiveActionDialog` (type-the-name confirmation); the server-side
// guarantee is admin session auth + the audit_log chain.
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../env.js';
import { makePolaris } from '../polaris.js';

export const adminProxyRoutes = new Hono<{ Bindings: Env }>();

// Body-size guard. The panel proxy fans out arbitrary admin payloads to
// services/api; without a cap, a compromised admin session could push
// multi-MB JSON through the panel and force services/api to parse it.
// Cap at 1 MiB (configurable via PANEL_BODY_LIMIT_BYTES) and reject with
// 413 before any downstream call. Streamed bodies without content-length
// fall through to the upstream API's own limits.
const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

function bodyLimitGuard(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'DELETE') {
      return next();
    }
    const limit = (() => {
      const raw = c.env.PANEL_BODY_LIMIT_BYTES;
      if (!raw) return DEFAULT_BODY_LIMIT_BYTES;
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) && n > 0 ? n : DEFAULT_BODY_LIMIT_BYTES;
    })();
    const lenHeader = c.req.header('content-length');
    if (lenHeader) {
      const len = Number.parseInt(lenHeader, 10);
      if (Number.isFinite(len) && len > limit) {
        return c.json({ error: 'payload_too_large', limit }, 413);
      }
    }
    return next();
  };
}

adminProxyRoutes.use('*', bodyLimitGuard());

// Forward the current request to services/api and return the body verbatim.
// `x-request-id` is propagated so service-binding log lines correlate back
// to the originating panel request.
const FORWARD_HEADERS = ['x-request-id'] as const;

async function forward(c: Context<{ Bindings: Env }>, upstream: string): Promise<Response> {
  const url = new URL(c.req.url);
  const query = url.searchParams.toString();
  const method = c.req.method.toUpperCase();
  const body =
    method === 'GET' || method === 'HEAD' || method === 'DELETE'
      ? undefined
      : await c.req.json().catch(() => ({}));
  const extraHeaders: Record<string, string> = {};
  for (const h of FORWARD_HEADERS) {
    const v = c.req.header(h);
    if (v) extraHeaders[h] = v;
  }
  const r = await makePolaris(c.env).call(
    method,
    upstream,
    body,
    query || undefined,
    Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined,
  );
  return c.json(r.body as Record<string, unknown>, r.status as ContentfulStatusCode);
}

// All /api/admin/* paths pass through unchanged. Each mutation still writes
// an audit_log row downstream; the audit chain (hash-chained in D1) is
// the canonical record of who did what.
adminProxyRoutes.all('/api/admin/*', async (c) => {
  const url = new URL(c.req.url);
  const upstream = url.pathname.replace(/^\/api\/admin/, '/v1/admin');
  return forward(c, upstream);
});

// Panel /api/messages/* mirrors GET /v1/messages and GET /v1/messages/:id with
// the admin operator key (the SDK adapter handles auth). Attachment downloads
// link straight to the R2 public custom domain (r2.mail.plrs.im); the panel
// no longer proxies those bytes.
adminProxyRoutes.get('/api/messages', async (c) => {
  const url = new URL(c.req.url);
  const r = await makePolaris(c.env).call(
    'GET',
    '/v1/messages',
    undefined,
    url.searchParams.toString() || undefined,
  );
  return c.json(r.body as Record<string, unknown>, r.status as ContentfulStatusCode);
});

adminProxyRoutes.get('/api/messages/:id', async (c) => {
  const id = c.req.param('id');
  const r = await makePolaris(c.env).call('GET', `/v1/messages/${id}`);
  return c.json(r.body as Record<string, unknown>, r.status as ContentfulStatusCode);
});
