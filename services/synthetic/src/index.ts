// Synthetic end-to-end Worker. Cron-triggered every minute. Sends a test message via the api
// and asserts it arrives back (via a webhook recorder, kept simple here: 200 status from the
// send endpoint is the minimum signal we can check without a captured webhook bridge).
import { sign, generateNonce } from '@polaris-email/hmac';

interface Env {
  API_BASE_URL: string;
  ALERT_WEBHOOK: string;
  SYNTHETIC_FROM: string;
  SYNTHETIC_TO: string;
  MAX_LATENCY_MS: string;
  SYNTHETIC_KEY_ID?: string;
  SYNTHETIC_KEY_SECRET?: string;
  /** Optional: status state across runs (R2 / KV) */
  KV?: KVNamespace;
}

let consecutiveFailures = 0;

export default {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const ok = await runOnce(env);
    consecutiveFailures = ok ? 0 : consecutiveFailures + 1;
    if (consecutiveFailures >= 2 && env.ALERT_WEBHOOK) {
      try {
        await fetch(env.ALERT_WEBHOOK, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ service: 'polaris-email', synthetic_failures: consecutiveFailures }),
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('synthetic alert failed', e);
      }
    }
  },
};

async function runOnce(env: Env): Promise<boolean> {
  if (!env.SYNTHETIC_KEY_ID || !env.SYNTHETIC_KEY_SECRET) {
    // eslint-disable-next-line no-console
    console.warn('synthetic: no key configured');
    return true; // don't alert on misconfig
  }
  const body = JSON.stringify({
    from: env.SYNTHETIC_FROM,
    to: [env.SYNTHETIC_TO],
    subject: `synthetic ${Date.now()}`,
    text: 'polaris-email synthetic',
    category: 'synthetic.outbound',
    mode: 'test',
  });
  const u = new URL(env.API_BASE_URL + '/v1/messages');
  const ts = String(Date.now());
  const nonce = generateNonce();
  const sig = await sign(
    { direction: 'polaris-api.v1', method: 'POST', path: u.pathname, query: u.search, ts, nonce, body },
    env.SYNTHETIC_KEY_SECRET,
  );
  const t0 = Date.now();
  try {
    const res = await fetch(u, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-polaris-key-id': env.SYNTHETIC_KEY_ID,
        'x-polaris-ts': ts,
        'x-polaris-nonce': nonce,
        'x-polaris-sig': sig,
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const dt = Date.now() - t0;
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.error('synthetic non-2xx', res.status);
      return false;
    }
    if (dt > Number.parseInt(env.MAX_LATENCY_MS, 10)) {
      // eslint-disable-next-line no-console
      console.error('synthetic over-latency', dt);
      return false;
    }
    return true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('synthetic exception', e);
    return false;
  }
}
