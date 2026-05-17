// polaris-email-docs Worker entrypoint.
//
// Serves the Docusaurus v3 static build under `build/` via the Workers
// Assets binding. The Worker layer is intentionally thin:
//   /healthz          — liveness
//   redirects table   — legacy URLs from the pre-Docusaurus docs tree
//   everything else   — falls through to the ASSETS binding
//
// The redirect table is hand-maintained here (not generated) because the
// source URLs are pinned by external links (GitHub READMEs, OIDC flows,
// prior CLI help text) and must stay stable. Whenever a doc moves, add a
// row here — don't lean on the build to back-track.
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';

type Env = { ASSETS: Fetcher; ENVIRONMENT?: string };

/**
 * Legacy-URL → new-IA mapping. Keys are normalised (no trailing `.md`,
 * no trailing slash). The order here mirrors the migration table in the
 * PR 12 plan so future entries can be appended in the same shape:
 *
 *   '<old-path>': '<new-path>',
 *
 * If the same old path could resolve to two reasonable new pages, pick
 * the one an operator-reading-a-runbook is more likely to need — the
 * formal spec sibling is reachable from there.
 */
const REDIRECTS: Record<string, string> = {
  // ----- Conceptual / overview pages --------------------------------
  '/architecture': '/operators/concepts/architecture',
  '/messages': '/developers/messages/unified-model',
  '/cost-model': '/operators/concepts/cost-model',
  '/mail-bridge': '/operators/concepts/mail-bridge',

  // ----- HMAC — operators land on the concept page; the formal spec
  // is one click away under /security.
  '/hmac-reference': '/developers/authentication/concept',
  '/hmac-spec': '/security/hmac-reference',

  // ----- SDK / developer entry points -------------------------------
  '/sdk': '/developers/sdks/node',
  '/sdk-node': '/developers/sdks/node',
  '/sdk-go': '/developers/sdks/go',
  '/quickstart': '/developers/quickstart',
  '/smtp-cookbook': '/developers/smtp-cookbook',
  '/webhook-decision-tree': '/developers/webhooks/decision-tree',
  '/webhooks': '/developers/webhooks',

  // ----- Operator runbooks / tour -----------------------------------
  '/deploy': '/get-started/30-min-first-deploy',
  '/first-deploy': '/get-started/30-min-first-deploy',
  '/operator': '/operators/day-2/cli-tour',
  '/monitoring': '/operators/day-2/monitoring',
  '/cloudflare-access': '/operators/deployment/cloudflare-access',
  '/access': '/operators/deployment/cloudflare-access',
  '/troubleshooting': '/operators/troubleshooting/decision-matrix',
  '/decision-matrix': '/operators/troubleshooting/decision-matrix',
  '/runbook': '/operators/runbooks',
  '/runbooks': '/operators/runbooks',
  '/runbooks/anchor-maintenance': '/operators/runbooks/anchor-maintenance',
  '/runbooks/credential-rotation': '/operators/runbooks/credential-rotation',
  '/runbooks/disaster-recovery': '/operators/runbooks/disaster-recovery',
  '/runbooks/dlq-replay': '/operators/runbooks/dlq-replay',
  '/runbooks/domain-onboarding': '/operators/runbooks/domain-onboarding',
  '/runbooks/incident-response': '/operators/runbooks/incident-response',
  '/runbooks/key-rotation': '/operators/runbooks/key-rotation',
  '/runbooks/killswitch': '/operators/runbooks/killswitch',
  '/runbooks/rollback': '/operators/runbooks/rollback',
  '/runbooks/smoke-test': '/operators/runbooks/smoke-test',

  // ----- Reference --------------------------------------------------
  '/cli': '/reference/cli',
  '/errors': '/reference/errors',
  '/api': '/reference/api',
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
// `/architecture.md` links also resolve, and strips a trailing slash so
// `/quickstart/` and `/quickstart` collapse to the same row.
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  const normalised = url.pathname.replace(/\.md$/, '').replace(/\/$/, '') || '/';
  const target = REDIRECTS[normalised];
  if (target) return c.redirect(target, 301);
  await next();
});

// Fall through to the static site. Workers Assets handles SPA-ish trailing
// slash rewrites and the 404 page (configured in wrangler.jsonc).
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;

// Exported for test access; the build does not depend on this surface.
export { REDIRECTS };
