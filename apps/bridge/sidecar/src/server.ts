// HTTP server for the sidecar. Routes:
//   GET /healthz
//   POST /mox/incoming-webhook       (Mox → sidecar; we forward to polaris-email if needed)
//   POST /mox/outgoing-webhook       (Mox → sidecar; SMTPS submission to forward via REST)
//   POST /hooks/:service/:rule       (polaris-email-fanout → consumer; sidecar verifies + proxies)
import Fastify, { type FastifyInstance } from 'fastify';
import { verify } from '@polaris-email/hmac';
import { SMTP_ERROR_MAP } from './config.js';
import type { PolarisClient } from './polaris-client.js';

export interface ServerDeps {
  polaris: PolarisClient;
  bridgeKeySecret: string;
  /** Map of (service, rule) → upstream URL on the docker network. Refreshed from /v1/bridge/config. */
  localTargets: Map<string, string>;
  /** Bridge-local nonce cache. */
  nonceSeen(nonce: string): boolean;
  rememberNonce(nonce: string, ttlMs: number): void;
  /** Verify Tailnet identity tag — true if caller is in the polaris-workers tag. */
  isTrustedWorker(req: { headers: Record<string, string | string[] | undefined> }): boolean;
}

export function createServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });

  app.get('/healthz', async () => ({ ok: true }));

  app.post('/mox/outgoing-webhook', async (req, reply) => {
    // Mox calls this with the outgoing message. We forward to polaris-email-api.
    // Each mailbox-scoped bridge key would normally be looked up via the SASL identity in
    // the payload; for v1, we use the bridge's broad key (the api enforces sender_scopes).
    const body = req.body as { account?: string; rfc822_b64?: string } | undefined;
    if (!body?.account || !body.rfc822_b64) return reply.code(400).send({ error: 'bad_request' });
    const r = await deps.polaris.request('POST', '/v1/messages', {
      from: '', // not used when format=raw; api parses
      to: [],
      category: 'svc.smtps',
      raw_b64: body.rfc822_b64,
    });
    if (r.status >= 400) {
      const errCode = (r.body as { error?: { code?: string } } | undefined)?.error?.code;
      const smtp = (errCode && SMTP_ERROR_MAP[errCode]) ?? '451 4.7.1 unspecified';
      return reply.code(r.status).send({ smtp_reply: smtp });
    }
    return reply.code(200).send({ ok: true });
  });

  app.post('/hooks/:service/:rule', async (req, reply) => {
    if (!deps.isTrustedWorker({ headers: req.headers })) {
      return reply.code(403).send({ error: 'untrusted_caller' });
    }
    const { service, rule } = req.params as { service: string; rule: string };
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(service) || !/^[a-z][a-z0-9-]{0,63}$/.test(rule)) {
      return reply.code(400).send({ error: 'bad_slug' });
    }
    const upstream = deps.localTargets.get(`${service}/${rule}`);
    if (!upstream) return reply.code(404).send({ error: 'no_target' });

    const nonce = req.headers['x-polaris-nonce'];
    if (typeof nonce === 'string') {
      if (deps.nonceSeen(nonce)) return reply.code(409).send({ error: 'nonce_replay' });
      deps.rememberNonce(nonce, 10 * 60_000);
    }

    // Re-validate webhook signature with the BRIDGE'S validator key (not the consumer's).
    // The fanout Worker pre-signed with the per-sub secret, but the bridge cannot hold all
    // those secrets. Instead we trust the Tailnet identity (already enforced above) and
    // forward unmodified, letting the consumer do their own verification. The bridge only
    // adds a `via-bridge` header for visibility.
    const bodyBuf = (await req.body) as Buffer | string | undefined;
    const body = typeof bodyBuf === 'string' ? bodyBuf : Buffer.isBuffer(bodyBuf) ? bodyBuf : JSON.stringify(bodyBuf ?? {});
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string' && k.toLowerCase().startsWith('x-polaris-')) headers[k] = v;
    }
    headers['x-polaris-via-bridge'] = 'true';
    headers['content-type'] = (req.headers['content-type'] as string) ?? 'application/json';
    try {
      const res = await fetch(upstream, {
        method: 'POST',
        headers,
        body: typeof body === 'string' ? body : Buffer.from(body).toString('utf8'),
        signal: AbortSignal.timeout(10_000),
      });
      const text = await res.text();
      return reply.code(res.status).type(res.headers.get('content-type') ?? 'application/json').send(text);
    } catch (e) {
      return reply.code(502).send({ error: 'upstream_failed', message: e instanceof Error ? e.message : 'unknown' });
    }
  });

  // Silence the unused-import for verify (kept available for future direct re-verification).
  void verify;

  return app;
}
