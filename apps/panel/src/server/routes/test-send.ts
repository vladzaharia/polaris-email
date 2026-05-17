// Panel-only test-send endpoints.
//
// POST /api/test-send             — wraps POST /v1/messages with the panel's
//                                   operator-scoped credential (HMAC + service
//                                   binding via makePolaris). Returns the new
//                                   message_id immediately.
// GET  /api/test-send/:id/stream  — Server-Sent Events stream that polls the
//                                   messages + message_deliveries tables every
//                                   500ms and emits canonical lifecycle events
//                                   (`queued → sending → sent → delivered` or
//                                   `failed`/`bounced`). Closes when a
//                                   terminal status is observed or after 60s.
import { Hono } from 'hono';
import type { Env } from '../env.js';
import { makePolaris } from '../polaris.js';

export const testSendRoutes = new Hono<{ Bindings: Env }>();

interface TestSendBody {
  from: string;
  to: string[];
  subject?: string;
  text?: string;
  html?: string;
  attachments?: { filename: string; content_type: string; content_base64: string }[];
}

testSendRoutes.post('/api/test-send', async (c) => {
  let body: TestSendBody;
  try {
    body = (await c.req.json()) as TestSendBody;
  } catch {
    return c.json({ error: 'bad_request', message: 'invalid json' }, 400);
  }
  if (!body.from || !Array.isArray(body.to) || body.to.length === 0) {
    return c.json({ error: 'bad_request', message: 'from + to required' }, 400);
  }
  const r = await makePolaris(c.env).call('POST', '/v1/messages', {
    from: body.from,
    to: body.to,
    subject: body.subject ?? '(test)',
    text: body.text ?? '',
    html: body.html,
    attachments: body.attachments ?? [],
  });
  return c.json(r.body as Record<string, unknown>, r.status as 200 | 400);
});

// SSE lifecycle stream. Polls the upstream API at GET /v1/messages/:id every
// 500ms and emits state transitions until we observe a terminal status (sent,
// delivered, failed, bounced) or hit the 60s ceiling.
//
// Lifetime semantics (Phase 6d.1):
//   The Worker stays alive as long as this Response's body stream is open
//   that's the standard CF Workers contract for streaming responses. We do
//   NOT need `c.executionCtx.waitUntil`; that pattern is for fire-and-forget
//   side effects AFTER the response is returned, but here the stream IS the
//   response body.
//
//   The `start()` function is async, so the `await new Promise(setTimeout)`
//   call yields the event loop and the runtime keeps the isolate hot until
//   the stream closes (terminal status, error, or the 60s ceiling). The
//   `controller.enqueue` calls flush immediately because no
//   `highWaterMark` backpressure is set on the underlying source.
testSendRoutes.get('/api/test-send/:id/stream', async (c) => {
  const id = c.req.param('id');
  const polaris = makePolaris(c.env);
  const encoder = new TextEncoder();
  const TERMINAL = new Set(['delivered', 'failed', 'bounced']);
  const MAX_MS = 60_000;
  const STEP_MS = 500;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown): void => {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(payload));
      };
      let lastStatus = '';
      const started = Date.now();
      try {
        while (Date.now() - started < MAX_MS) {
          const r = await polaris.call<{ status?: string; id?: string }>(
            'GET',
            `/v1/messages/${id}`,
          );
          if (r.status >= 400) {
            send('error', { status: r.status, body: r.body });
            break;
          }
          const status = String((r.body as { status?: string }).status ?? '');
          if (status && status !== lastStatus) {
            send(status, { message_id: id, status, at: Date.now() });
            lastStatus = status;
          }
          if (TERMINAL.has(status)) break;
          await new Promise((res) => setTimeout(res, STEP_MS));
        }
        send('close', { message_id: id });
      } catch (err) {
        // Surface upstream failures as a final SSE error event so the
        // client's named-event handler (Phase 6d.2) can react. Without
        // this catch the controller would error and the client EventSource
        // would silently reconnect.
        send('error', { message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
});
