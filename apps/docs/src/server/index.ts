// polaris-email-docs Worker entrypoint.
//
// Serves the Docusaurus v3 static build under `build/` via the Workers
// Assets binding. The Worker layer is intentionally thin:
//   /healthz          — liveness
//   redirects table   — legacy URLs from the pre-Docusaurus docs tree
//   everything else   — falls through to the ASSETS binding
//
// PR 12 expands the redirect table from the actual content migration. The
// table is hand-maintained here (not generated) because the source URLs
// are pinned by external links (GitHub READMEs, OIDC flows, prior CLI
// help text) and must stay stable.
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';

type Env = { ASSETS: Fetcher; ENVIRONMENT?: string };

// Legacy-URL → new-IA mapping. Keys are normalized (trailing `.md` stripped,
// no trailing slash). PR 12 will fill this in from the migration table; the
// entries below are illustrative seeds the new IA already supports.
const REDIRECTS: Record<string, string> = {
  '/architecture': '/operators/concepts/architecture',
  '/operator': '/operators/day-2/cli-tour',
  '/sdk': '/developers/sdks/node',
  '/hmac-reference': '/developers/authentication/concept',
};

const app = new Hono<{ Bindings: Env }>();

// CSP for a Docusaurus-rendered static site. Scripts + styles need
// 'unsafe-inline' because Docusaurus injects its theme toggle and search
// bootstrap inline; this matches the panel's posture but with a slightly
// wider style allowance.
app.use(
  '*',
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'data:'],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
    },
  }),
);

app.get('/healthz', (c) => c.json({ ok: true }));

// Redirect middleware. Runs before ASSETS so 301s aren't shadowed by a
// 404 for an unmoved path. Strips a `.md` suffix so old GitHub-style
// `/architecture.md` links also resolve.
app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname.replace(/\.md$/, '');
  const target = REDIRECTS[path];
  if (target) return c.redirect(target, 301);
  await next();
});

// Fall through to the static site. Workers Assets handles SPA-ish trailing
// slash rewrites and the 404 page (configured in wrangler.jsonc).
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
