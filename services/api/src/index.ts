// polaris-email-api Worker entrypoint.
import { Hono } from 'hono';
import { admin } from './routes/admin.js';
import { bootstrap } from './routes/bootstrap.js';
import type { Env } from './env.js';
import { messages } from './routes/messages.js';
import { sendRaw } from './routes/send-raw.js';
import { requestId } from '@polaris-email/ids';
import { buildError } from './errors.js';
export { RevocationDO } from '@polaris-email/revocation-do';

const app = new Hono<{ Bindings: Env }>();

app.use('*', async (c, next) => {
  c.set('requestId', requestId());
  await next();
  // Always add the request id for log correlation, even on success.
  c.header('x-request-id', c.get('requestId'));
});

app.get('/healthz', (c) => c.json({ ok: true }));

app.route('/', messages);
app.route('/', sendRaw);
app.route('/', admin);
app.route('/', bootstrap);

app.notFound((c) => buildError(c, 'not_found', `no route for ${c.req.method} ${new URL(c.req.url).pathname}`));

app.onError((err, c) => {
  console.error('unhandled', err.stack);
  return buildError(c, 'degraded', 'unhandled error');
});

export default app;
