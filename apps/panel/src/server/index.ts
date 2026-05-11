import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { readEnv } from './env.js';
import { openDb } from './db.js';
import { makePolaris } from './polaris.js';
import { requireAdmin, sessionMiddleware } from './auth.js';
import { servicesRoutes } from './routes/services.js';
import { apiKeysRoutes } from './routes/api-keys.js';
import { mailboxesRoutes } from './routes/mailboxes.js';
import { webhooksRoutes } from './routes/webhooks.js';
import { routingRoutes } from './routes/routing.js';
import { auditRoutes } from './routes/audit.js';
import { diagnosticsRoutes } from './routes/diagnostics.js';
import { sessionRoutes } from './routes/session.js';

async function main() {
  const env = readEnv();
  const db = openDb(env.SQLITE_PATH);
  const polaris = makePolaris({
    baseUrl: env.POLARIS_EMAIL_URL,
    keyId: env.PANEL_ADMIN_KEY_ID,
    keySecret: env.PANEL_ADMIN_KEY_SECRET,
  });
  const app = new Hono();
  app.use('*', sessionMiddleware(db));
  app.get('/healthz', (c) => c.json({ ok: true }));
  app.route('/', sessionRoutes(db, { adminGroup: env.ADMIN_GROUP, devMode: env.DEV_MODE === '1' }));
  // Everything below requires admin group.
  const guarded = new Hono();
  guarded.use('*', requireAdmin(env.ADMIN_GROUP));
  guarded.route('/', servicesRoutes(polaris));
  guarded.route('/', apiKeysRoutes(polaris));
  guarded.route('/', mailboxesRoutes(polaris));
  guarded.route('/', webhooksRoutes(polaris));
  guarded.route('/', routingRoutes(polaris));
  guarded.route('/', auditRoutes(polaris));
  guarded.route('/', diagnosticsRoutes(polaris));
  app.route('/', guarded);

  const port = Number.parseInt(env.PANEL_PORT, 10);
  serve({ fetch: app.fetch, port });
  // eslint-disable-next-line no-console
  console.log('panel listening on', port);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('panel fatal', e);
  process.exitCode = 1;
});
