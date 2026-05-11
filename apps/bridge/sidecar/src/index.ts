// polaris-email-bridge sidecar entrypoint.
import { envOrThrow } from './config.js';
import { makeClient } from './polaris-client.js';
import { makeMoxClient } from './mox-client.js';
import { createServer } from './server.js';
import { runSyncLoop } from './sync-loop.js';

async function main() {
  const env = envOrThrow();
  const polaris = makeClient({
    baseUrl: env.POLARIS_EMAIL_URL,
    keyId: env.POLARIS_BRIDGE_KEY_ID,
    keySecret: env.POLARIS_BRIDGE_KEY_SECRET,
  });
  const mox = makeMoxClient({
    sockPath: env.MOX_WEBAPI_SOCK ?? '/run/mox/webapi.sock',
    ...(env.MOX_WEBAPI_URL ? { baseUrl: env.MOX_WEBAPI_URL } : {}),
  });

  const localTargets = new Map<string, string>();
  const mailboxes = new Map<string, { account: string }>();

  async function loadConfig() {
    const r = await polaris.request<{
      mailboxes: { id: string; address: string }[];
      local_webhook_targets: { service: string; rule: string; upstream: string }[];
    }>('GET', '/v1/bridge/config');
    if (r.status !== 200) throw new Error('config fetch failed ' + r.status);
    const conf = r.body;
    localTargets.clear();
    for (const t of conf.local_webhook_targets) localTargets.set(`${t.service}/${t.rule}`, t.upstream);
    mailboxes.clear();
    for (const m of conf.mailboxes) {
      // Mox account name = local part of the address.
      const account = m.address.split('@')[0];
      if (account) mailboxes.set(m.id, { account });
    }
  }
  await loadConfig();

  const nonceCache = new Map<string, number>();
  const server = createServer({
    polaris,
    bridgeKeySecret: env.POLARIS_BRIDGE_KEY_SECRET,
    localTargets,
    nonceSeen: (n) => {
      const exp = nonceCache.get(n);
      if (!exp) return false;
      if (exp < Date.now()) {
        nonceCache.delete(n);
        return false;
      }
      return true;
    },
    rememberNonce: (n, ttl) => {
      nonceCache.set(n, Date.now() + ttl);
      // GC if size grows
      if (nonceCache.size > 10_000) {
        const now = Date.now();
        for (const [k, v] of nonceCache) if (v < now) nonceCache.delete(k);
      }
    },
    isTrustedWorker: (req) => {
      // Tailscale Serve attaches Tailscale-User-Login + tags via Tailscale-Tag header for
      // tagged callers. Trust callers tagged tag:polaris-workers.
      const t = req.headers['tailscale-user-tags'] ?? req.headers['tailscale-tag'];
      if (typeof t === 'string') return t.split(',').includes('tag:polaris-workers');
      if (Array.isArray(t)) return t.some((x) => x.split(',').includes('tag:polaris-workers'));
      return false;
    },
  });

  const port = Number.parseInt(env.LISTEN_PORT ?? '8088', 10);
  await server.listen({ port, host: '0.0.0.0' });
  // eslint-disable-next-line no-console
  console.log('sidecar listening on', port);

  const ac = new AbortController();
  process.on('SIGTERM', () => ac.abort());
  process.on('SIGHUP', () => {
    loadConfig().catch((e) => console.error('SIGHUP reload failed', e));
  });

  runSyncLoop({
    polaris,
    mox,
    mailboxes,
    signal: ac.signal,
    intervalMs: Number.parseInt(env.POLL_INTERVAL_MS ?? '5000', 10),
  }).catch((e) => console.error('sync loop crashed', e));
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('sidecar fatal', e);
  process.exitCode = 1;
});
