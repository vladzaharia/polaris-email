// polaris-mail-api Worker entrypoint.
//
// Three Cloudflare entry points share this Worker, all bound from
// `services/api/wrangler.jsonc`:
//
//   * `fetch`     — Hono router (HTTP requests).
//   * `scheduled` — cron dispatcher absorbed from the standalone `cron`
//                   Worker. Routes on `event.cron`.
//   * `queue`     — FANOUT_QUEUE consumer absorbed from the standalone
//                   `fanout` Worker. Bounded concurrency keeps
//                   webhook POST latency out of the HTTP request path.
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { admin } from './routes/admin.js';
import { auth } from './routes/auth.js';
import { bootstrap } from './routes/bootstrap.js';
import { debugRoutes } from './routes/debug.js';
import type { Env } from './env.js';
import { messages } from './routes/messages.js';
import { messagesState } from './routes/messages-state.js';
import { internalCfEvents } from './routes/internal-cf-events.js';
import { mtaStsPolicy } from './routes/mta-sts.js';
import { unsub } from './routes/unsub.js';
import { bridgeHeartbeat } from './routes/bridge/heartbeat.js';
import { bridgeConfig } from './routes/bridge/config.js';
import { requestId } from '@polaris-mail/ids';
import { buildError } from './errors.js';
import { scheduled } from './scheduled/index.js';
import { fanoutQueueConsumer, type FanoutEvent } from './queue/fanout.js';

const app = new Hono<{ Bindings: Env }>();

// Phase 3d — apply secure-headers middleware before any route. This is a
// JSON-only API surface so we don't set a CSP (no HTML render path); the
// defaults give us X-Content-Type-Options, X-Frame-Options, Referrer-Policy,
// HSTS, and friends with no per-route configuration.
app.use('*', secureHeaders());

app.use('*', async (c, next) => {
  c.set('requestId', requestId());
  await next();
  // Always add the request id for log correlation, even on success.
  c.header('x-request-id', c.get('requestId'));
});

app.get('/healthz', (c) => c.json({ ok: true }));

// public, unauthenticated MTA-STS policy origin.
// MUST be mounted BEFORE any auth-bearing routes: sender MTAs fetch this
// anonymously per RFC 8461 §3.3. The handler itself short-circuits to
// `c.notFound()` for any Host that does not start with `mta-sts.`, so
// mounting it at root cannot leak the policy on unrelated hostnames.
app.route('/', mtaStsPolicy);

app.route('/', messages);
app.route('/', messagesState);
app.route('/', internalCfEvents);
app.route('/', unsub);
// Bridge self-fetch endpoints — mounted BEFORE admin so their
// `/v1/bridge/*` handlers win routing. The admin router still owns the
// rest of `/v1/bridge/*` (credential lookup) under admin-api-key auth.
app.route('/', bridgeHeartbeat);
app.route('/', bridgeConfig);
app.route('/', admin);
app.route('/', auth);
app.route('/', bootstrap);
// /v1/debug/* — self-gated on env.DEV_MODE. Production deploys 404 here.
app.route('/', debugRoutes);

app.notFound((c) =>
  buildError(c, 'not_found', `no route for ${c.req.method} ${new URL(c.req.url).pathname}`),
);

app.onError((err, c) => {
  // Workers logpush + tail captures console.error; this is the only
  // observability surface for unhandled errors in production. Emit
  // structured JSON so log queries can group by error class; deliberately
  // do NOT log the full stack (paths leak source layout).
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({
      event: 'unhandled_error',
      name: err.name,
      message: err.message,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
    }),
  );
  return buildError(c, 'degraded', 'unhandled error');
});

// Export the Hono `app` so existing tests that call `app.fetch(...)` directly
// continue to work without an indirection through the default export.
export { app };

const FANOUT_QUEUE_NAME = 'polaris-mail-fanout';

export default {
  fetch: app.fetch.bind(app),
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await scheduled(event, env);
  },
  async queue(batch: MessageBatch<unknown>, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (batch.queue === FANOUT_QUEUE_NAME) {
      await fanoutQueueConsumer(batch as MessageBatch<FanoutEvent>, env);
      return;
    }
    // eslint-disable-next-line no-console
    console.warn(`queue: unknown binding ${batch.queue}`);
  },
};
