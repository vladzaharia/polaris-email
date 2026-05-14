// polaris-email-panel Worker entrypoint.
//
// The panel runs as a Workers module: it serves
//   /api/auth/*       — mounted better-auth handler (sign-in/out, OIDC callbacks, sessions)
//   /api/*            — panel REST surface (proxies to services/api via the API service binding)
//   /healthz          — liveness
//   everything else   — falls through to the Workers Assets binding (the Vite SPA bundle)
import { Hono } from 'hono';
import type { Env } from './env.js';
import { makeAuth } from './auth/index.js';
import { sessionMiddleware, requireAdmin } from './auth/step-up.js';
import { approvalsRoutes } from './auth/approvals.js';
import { sessionRoutes } from './routes/session.js';
import { tenantsRoutes } from './routes/tenants.js';
import { apiKeysRoutes } from './routes/api-keys.js';
import { webhooksRoutes } from './routes/webhooks.js';
import { routingRoutes } from './routes/routing.js';
import { auditRoutes } from './routes/audit.js';
import { diagnosticsRoutes } from './routes/diagnostics.js';
import { adminProxyRoutes } from './routes/admin-proxy.js';
import { testSendRoutes } from './routes/test-send.js';

const app = new Hono<{ Bindings: Env }>();

app.get('/healthz', (c) => c.json({ ok: true }));

// Better-auth's HTTP handler covers /api/auth/* (sign-in, sign-out, OIDC
// callback, sessions). Mounted before the session middleware so the auth
// flow itself doesn't require an existing session.
app.all('/api/auth/*', (c) => {
  const auth = makeAuth(c.env);
  return auth.handler(c.req.raw);
});

app.use('/api/*', sessionMiddleware());
app.route('/', sessionRoutes);
app.route('/', approvalsRoutes);

// Admin-only surface.
const guarded = new Hono<{ Bindings: Env }>();
guarded.use('*', requireAdmin());
guarded.route('/', tenantsRoutes);
guarded.route('/', apiKeysRoutes);
guarded.route('/', webhooksRoutes);
guarded.route('/', routingRoutes);
guarded.route('/', auditRoutes);
guarded.route('/', diagnosticsRoutes);
guarded.route('/', adminProxyRoutes);
guarded.route('/', testSendRoutes);
app.route('/', guarded);

// Fall through to the static SPA bundle for non-API paths. The ASSETS binding
// serves dist/client/ directly; Workers Assets handles index.html SPA fallback
// when configured at deploy time.
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
