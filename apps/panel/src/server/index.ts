// polaris-email-panel Worker entrypoint.
//
// The panel runs as a Workers module: it serves
//   /api/auth/*       — mounted better-auth handler (sign-in/out, OIDC callbacks, sessions)
//   /api/*            — panel REST surface (proxies to services/api via the API service binding)
//   /healthz          — liveness
//   everything else   — falls through to the Workers Assets binding (the Vite SPA bundle)
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import type { Env } from './env.js';
import { makeAuth } from './auth/index.js';
import { sessionMiddleware, requireAdmin } from './auth/middleware.js';
import { sessionRoutes } from './routes/session.js';
import { apiKeysRoutes } from './routes/api-keys.js';
import { webhooksRoutes } from './routes/webhooks.js';
import { auditRoutes } from './routes/audit.js';
import { diagnosticsRoutes } from './routes/diagnostics.js';
import { adminProxyRoutes } from './routes/admin-proxy.js';
import { testSendRoutes } from './routes/test-send.js';

const app = new Hono<{ Bindings: Env }>();

// Phase 3d — secure-headers middleware applied before any route. CSP is
// configured for the panel SPA: scripts only from self, styles allow inline
// (Tailwind v4 + shadcn requires inline style attributes for runtime CSS
// variables), images allow data: URIs (icons/QR codes), and connect-src is
// limited to self so the React client can only call back to the panel
// origin (which proxies to services/api). frame-ancestors 'none' blocks
// clickjacking; object-src 'none' blocks legacy plugin embedding.
//
// The middleware emits the Content-Security-Policy header on every response;
// browsers ignore it on JSON responses so applying it globally is safe.
app.use(
  '*',
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
    },
  }),
);

// Phase 3e.3 — DEV_MODE assertion. The /api/dev/login backdoor in
// routes/session.ts is gated on env.DEV_MODE === '1'. If a Worker is
// deployed to an environment with ENVIRONMENT='production' AND DEV_MODE
// is set, refuse to serve traffic — this is a misconfiguration that would
// expose the dev backdoor. The check runs once per request (cheap string
// compare) so the check is durable across redeploys.
app.use('*', async (c, next) => {
  if (c.env.DEV_MODE === '1' && c.env.ENVIRONMENT === 'production') {
    // eslint-disable-next-line no-console
    console.error('FATAL: DEV_MODE=1 in production environment; refusing to serve');
    return c.json({ error: 'misconfigured' }, 500);
  }
  await next();
});

app.get('/healthz', (c) => c.json({ ok: true }));

// Better-auth's failure path is `302 /api/auth/error?error=<code>` —
// e.g. an expired authorization code, a state-cookie mismatch, or an
// IdP-side denial. Without this intercept the operator lands on
// better-auth's bare API error response and the panel's UI never gets a
// chance to surface a friendly retry. Forward to /login with the same
// query so Login.tsx's existing `?error` handling can render an error
// state + manual retry button. Registered BEFORE the catch-all so it
// wins in Hono's first-match routing.
app.get('/api/auth/error', (c) => {
  const u = new URL(c.req.url);
  const qs = u.search.length > 1 ? u.search.slice(1) : 'error=unknown';
  return c.redirect(`/login?${qs}`, 302);
});

// Better-auth's HTTP handler covers /api/auth/* (sign-in, sign-out, OIDC
// callback, sessions). Mounted before the session middleware so the auth
// flow itself doesn't require an existing session.
app.all('/api/auth/*', (c) => {
  const auth = makeAuth(c.env);
  return auth.handler(c.req.raw);
});

app.use('/api/*', sessionMiddleware());
app.route('/', sessionRoutes);

// Admin-only surface. requireAdmin() enforces the role check once at the
// routing boundary; downstream handlers can rely on c.get('session').admin.
const guarded = new Hono<{ Bindings: Env }>();
guarded.use('*', requireAdmin());
guarded.route('/', apiKeysRoutes);
guarded.route('/', webhooksRoutes);
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
