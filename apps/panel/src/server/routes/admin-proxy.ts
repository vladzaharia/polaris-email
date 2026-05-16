// Generic /api/admin/* passthrough to services/api over the API service
// binding. Panel pages call this surface; the polaris SDK adapter
// (server/polaris.ts) injects HMAC if PANEL_ADMIN_KEY_* are set, otherwise the
// service binding alone authenticates.
//
// The proxy preserves query string + method + JSON body, and surfaces the
// downstream status code verbatim so two-person-approval 428 responses flow
// through to the client. Per-route gates (`withApproval(action)`) are mounted
// BEFORE the catchall for destructive operations — see the explicit handlers
// at the top of this file. The catchall only handles read-only and benign
// endpoints.
//
// Hono routes are matched in registration order, and explicit method+path
// handlers win over the `all('/api/admin/*')` catchall when the prefix
// matches. Adding a new destructive endpoint? Wrap it in `withApproval(action)`
// here so the panel cannot fire it without a co-signed approval row.
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../env.js';
import { makePolaris } from '../polaris.js';
import { withApproval } from '../auth/approvals.js';

export const adminProxyRoutes = new Hono<{ Bindings: Env }>();

/**
 * Phase 3e.2 — body-size guard. The panel proxy fans out arbitrary admin
 * payloads to services/api; without a cap, an admin (or compromised admin
 * session) could push multi-MB JSON through the panel and force services/api
 * to parse and forward it. Cap at 1 MiB (configurable via
 * `PANEL_BODY_LIMIT_BYTES`) and reject with 413 before any downstream call.
 *
 * The check is a content-length sniff — Workers' Hono runtime exposes the
 * incoming `content-length` header. Streamed bodies without that header
 * fall through (the upstream API will catch them at its own boundary), but
 * every common JSON client sets it.
 */
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

// Helper: forward the current request to services/api and return the body
// verbatim. Centralised so each gated handler stays one line of "what action,
// what upstream path".
//
// Phase 6d.6 — header forwarding. The approval gate (`x-polaris-approval-id`)
// is consumed at the panel and is intentionally NOT forwarded; services/api
// trusts the service-binding boundary for admin authority. We DO forward
// `x-request-id` so log lines on services/api can correlate back to the
// originating panel request. (`x-polaris-tenant` and `x-polaris-actor` are
// not surfaced from the panel today; if the SDK starts populating them they
// should join the allowlist below.)
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

// --- Destructive routes (gated on two-person approval) ---------------------
//
// Each entry pairs the panel-facing path with a stable `action` string that
// the approvals table records. The action names are also what the operator
// sees in the pending-approvals UI, so keep them descriptive but short.

// Bridges
adminProxyRoutes.post('/api/admin/bridges/:id/rotate', withApproval('bridge.rotate'), (c) =>
  forward(c, `/v1/admin/bridges/${c.req.param('id')}/rotate`),
);
adminProxyRoutes.delete('/api/admin/bridges/:id', withApproval('bridge.deregister'), (c) =>
  forward(c, `/v1/admin/bridges/${c.req.param('id')}`),
);

// Credentials
adminProxyRoutes.post('/api/admin/credentials/:id/rotate', withApproval('credential.rotate'), (c) =>
  forward(c, `/v1/admin/credentials/${c.req.param('id')}/rotate`),
);
adminProxyRoutes.post('/api/admin/credentials/:id/revoke', withApproval('credential.revoke'), (c) =>
  forward(c, `/v1/admin/credentials/${c.req.param('id')}/revoke`),
);

// Domains
adminProxyRoutes.post(
  '/api/admin/domains/:id/rotate-dkim',
  withApproval('domain.rotate_dkim'),
  (c) => forward(c, `/v1/admin/domains/${c.req.param('id')}/rotate-dkim`),
);
adminProxyRoutes.post(
  '/api/admin/domains/:id/inbound/disable',
  withApproval('domain.inbound_disable'),
  (c) => forward(c, `/v1/admin/domains/${c.req.param('id')}/inbound/disable`),
);
adminProxyRoutes.delete('/api/admin/domains/:id', withApproval('domain.delete'), (c) =>
  forward(c, `/v1/admin/domains/${c.req.param('id')}`),
);

// Mailbox sender / receiver disable (DELETE on the panel surface; the
// upstream is a soft-disable, but we treat it as destructive because mail
// flow stops on the next request).
adminProxyRoutes.delete(
  '/api/admin/mailboxes/:id/senders/:senderId',
  withApproval('mailbox.sender.disable'),
  (c) => forward(c, `/v1/admin/mailboxes/${c.req.param('id')}/senders/${c.req.param('senderId')}`),
);
adminProxyRoutes.delete(
  '/api/admin/mailboxes/:id/receivers/:receiverId',
  withApproval('mailbox.receiver.disable'),
  (c) =>
    forward(c, `/v1/admin/mailboxes/${c.req.param('id')}/receivers/${c.req.param('receiverId')}`),
);

// Webhook subscription delete + DLQ drop
adminProxyRoutes.delete('/api/admin/webhook-subs/:id', withApproval('webhook_sub.delete'), (c) =>
  forward(c, `/v1/admin/webhook-subs/${c.req.param('id')}`),
);
adminProxyRoutes.post('/api/admin/webhook-dlq/:id/drop', withApproval('webhook_dlq.drop'), (c) =>
  forward(c, `/v1/admin/webhook-dlq/${c.req.param('id')}/drop`),
);

// W2b — Operator override on a triage event records dissent + can flip an
// auto-applied suppression. Approval-gated.
adminProxyRoutes.post(
  '/api/admin/triage-events/:id/override',
  withApproval('triage.operator_override'),
  (c) => forward(c, `/v1/admin/triage-events/${c.req.param('id')}/override`),
);

// W8 — DMARC promotion mutations all touch live state (pause/resume the
// auto-promotion cron, claim DNS management, run the cron immediately).
// Approval-gate them all.
adminProxyRoutes.post('/api/admin/dmarc-promotion/:id/pause', withApproval('dmarc.pause'), (c) =>
  forward(c, `/v1/admin/dmarc-promotion/${c.req.param('id')}/pause`),
);
adminProxyRoutes.post('/api/admin/dmarc-promotion/:id/resume', withApproval('dmarc.resume'), (c) =>
  forward(c, `/v1/admin/dmarc-promotion/${c.req.param('id')}/resume`),
);
adminProxyRoutes.post(
  '/api/admin/dmarc-promotion/:id/claim-management',
  withApproval('dmarc.claim_management'),
  (c) => forward(c, `/v1/admin/dmarc-promotion/${c.req.param('id')}/claim-management`),
);
adminProxyRoutes.post('/api/admin/dmarc-promotion/run', withApproval('dmarc.promote_run'), (c) =>
  forward(c, '/v1/admin/dmarc-promotion/run'),
);

// W2c — manual "Run threshold cron now" is approval-gated (it can suppress
// senders, so it's destructive).
adminProxyRoutes.post(
  '/api/admin/sender-abuse-threshold/run',
  withApproval('sender_abuse.threshold_run'),
  (c) => forward(c, '/v1/admin/sender-abuse-threshold/run'),
);

// W2d — Test-alert button is approval-gated; the read-only listing falls
// through to the catchall.
adminProxyRoutes.post('/api/admin/alerts/test', withApproval('admin.alert.test'), (c) =>
  forward(c, '/v1/admin/alerts/test'),
);

// W1 — Suppressions. Manual add + manual disable both require dual-admin
// approval (the worst-case blast radius of a wrong sender suppression is a
// pause on every outbound message for that principal; a wrong recipient
// unsuppress could resume delivery to a real spam-trap address).
adminProxyRoutes.post('/api/admin/suppressions', withApproval('suppression.create'), (c) =>
  forward(c, '/v1/admin/suppressions'),
);
adminProxyRoutes.delete('/api/admin/suppressions/:id', withApproval('suppression.disable'), (c) =>
  forward(
    c,
    `/v1/admin/suppressions/${c.req.param('id')}${c.req.query() ? '?' + new URLSearchParams(c.req.query()).toString() : ''}`,
  ),
);

// Tenant quarantine — emergency revoke for the bulk path.
adminProxyRoutes.post('/api/admin/bulk/revoke-tenant', withApproval('tenant.quarantine'), (c) =>
  forward(c, '/v1/admin/bulk/revoke-tenant'),
);

// CF-zone configure — gated only for non-dry-run requests. Dry-run is the
// default and merely returns the diff (read-only); applying the diff mutates
// CF state (toggles routing, sets catch-all, onboards senders, inserts a
// `mail_domains` row) and so must clear two-person approval. We sniff the
// body to pick the right gate; on parse failure we fall through to the
// approval gate (safer to require approval than skip it).
const cfZoneApprovalGate = withApproval('cf_zone.configure');
adminProxyRoutes.post('/api/admin/cf-zones/:name/configure', async (c) => {
  // Hono caches parsed JSON on the request object so the downstream
  // `forward()` re-reads the same body without burning the stream.
  let body: { dry_run?: boolean } = {};
  try {
    body = (await c.req.json()) as { dry_run?: boolean };
  } catch {
    /* fall through — treat as non-dry-run */
  }
  const dryRun = body.dry_run !== false; // default true
  const upstream = `/v1/admin/cf-zones/${c.req.param('name')}/configure`;
  if (dryRun) {
    return forward(c, upstream);
  }
  // Non-dry-run → require approval. Surface a forwarded response from the
  // approval middleware's `next` callback so the gate can short-circuit with
  // a 428 unchanged.
  let response: Response | undefined;
  await cfZoneApprovalGate(c, async () => {
    response = await forward(c, upstream);
  });
  // If the gate short-circuited (e.g. returned a 428), Hono will have set
  // `c.res` for us; otherwise return the captured response.
  return response ?? c.res;
});

// --- Catch-all (read-only + benign mutations) -----------------------------
//
// Anything that doesn't match an explicit handler above falls through here.
// Add a new destructive endpoint to the explicit list above; do NOT rely on
// this catchall to gate sensitive operations.
adminProxyRoutes.all('/api/admin/*', async (c) => {
  const url = new URL(c.req.url);
  const upstream = url.pathname.replace(/^\/api\/admin/, '/v1/admin');
  return forward(c, upstream);
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
  return c.json(r.body as Record<string, unknown>, r.status as ContentfulStatusCode);
});

adminProxyRoutes.get('/api/messages/:id', async (c) => {
  const id = c.req.param('id');
  const r = await makePolaris(c.env).call('GET', `/v1/messages/${id}`);
  return c.json(r.body as Record<string, unknown>, r.status as ContentfulStatusCode);
});

// The previous `/api/messages/:id/attachments/:n` panel route is gone (B5).
// Attachments now carry an `url` field that points straight at the R2 public
// custom domain `r2.mail.plrs.im`; the panel links to that URL directly.
