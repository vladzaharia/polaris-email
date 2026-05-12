// polaris-email-bridge sidecar entrypoint.
import { envOrThrow } from './config.js';
import { makeClient } from './polaris-client.js';
import { makeMoxClient } from './mox-client.js';
import { createServer } from './server.js';
import { runSyncLoop } from './sync-loop.js';
import { drainMoxOpsOnce } from './mox-ops.js';

async function main() {
  const env = envOrThrow();
  const polaris = makeClient({
    baseUrl: env.POLARIS_EMAIL_URL,
    keyId: env.POLARIS_BRIDGE_KEY_ID,
    keySecret: env.POLARIS_BRIDGE_KEY_SECRET,
  });
  const mox = makeMoxClient({
    adminBaseUrl: env.MOX_ADMIN_URL ?? 'http://127.0.0.1:80',
    webapiBaseUrl: env.MOX_WEBAPI_URL ?? env.MOX_ADMIN_URL ?? 'http://127.0.0.1:80',
    adminPassword: env.MOX_ADMIN_PASSWORD ?? '',
    submitHost: env.MOX_SUBMIT_HOST ?? '127.0.0.1',
    submitPort: env.MOX_SUBMIT_PORT ? Number.parseInt(env.MOX_SUBMIT_PORT, 10) : 465,
  });

  const localTargets = new Map<string, string>();
  const mailboxes = new Map<string, { account: string; address?: string; password?: string }>();

  interface BridgeSenderRow {
    id: string;
    address: string;
    display_name: string | null;
    disabled: boolean;
    smtp_credentials: {
      id: string;
      username: string;
      // password_hash is included by the api Worker but the sidecar does not
      // consume it for Mox sync (Mox needs plaintext; see mox-client.ts).
      password_hash?: string;
      disabled: boolean;
    }[];
  }
  async function loadConfig() {
    const r = await polaris.request<{
      mailboxes: { id: string; address: string }[];
      local_webhook_targets: { service: string; rule: string; upstream: string }[];
      senders?: BridgeSenderRow[];
    }>('GET', '/v1/bridge/config');
    if (r.status !== 200) throw new Error('config fetch failed ' + r.status);
    const conf = r.body;
    localTargets.clear();
    for (const t of conf.local_webhook_targets) localTargets.set(`${t.service}/${t.rule}`, t.upstream);
    mailboxes.clear();
    for (const m of conf.mailboxes) {
      // Mox account name = full address (matches the convention used in
      // mox-ops.ts where username is the address).
      mailboxes.set(m.id, { account: m.address, address: m.address });
    }
    // Reconcile Mox accounts for each sender. Best-effort: one bad sender should
    // not halt sync.
    //
    // Mox's admin API does NOT accept pre-hashed passwords (see mox-client.ts).
    // We therefore only manage account existence here. Passwords are pushed
    // via a separate one-time webhook (POST /bridge/credential-set) at the
    // moment of credential issuance; the api Worker holds plaintext exactly
    // long enough to fire that webhook, then stores only the hash at rest.
    for (const sender of conf.senders ?? []) {
      const account = sender.address;
      const hasActive = sender.smtp_credentials.some((cred) => !cred.disabled);
      if (sender.disabled || !hasActive) {
        await mox.removeAccount(account).catch(() => false);
        continue;
      }
      await mox
        .ensureAccount({ account, address: sender.address })
        .catch((e: unknown) => {
          // eslint-disable-next-line no-console
          console.warn(
            `bridge: ensureAccount failed for ${account}: ${e instanceof Error ? e.message : 'unknown'}`,
          );
          return false;
        });
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
    // Drain the pending-Mox-ops queue on every tick. This is how plaintext SMTP
    // passwords issued by the api Worker actually make it into Mox. Failures
    // here never halt the inbound sync loop (runSyncLoop catches).
    drainMoxOps: () => drainMoxOpsOnce({ polaris, mox }).then(() => undefined),
  }).catch((e) => console.error('sync loop crashed', e));
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('sidecar fatal', e);
  process.exitCode = 1;
});
