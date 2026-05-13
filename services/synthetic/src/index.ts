// Synthetic liveness probe. Cron-triggered every minute. Hits /healthz on the API and
// alerts after two consecutive failures.
interface Env {
  API_BASE_URL: string;
  ALERT_WEBHOOK: string;
  MAX_LATENCY_MS: string;
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
          body: JSON.stringify({
            service: 'polaris-email',
            synthetic_failures: consecutiveFailures,
          }),
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('synthetic alert failed', e);
      }
    }
  },
};

async function runOnce(env: Env): Promise<boolean> {
  if (!env.API_BASE_URL) {
    // eslint-disable-next-line no-console
    console.warn('synthetic: no API_BASE_URL configured');
    return true;
  }
  const t0 = Date.now();
  try {
    const res = await fetch(new URL(env.API_BASE_URL + '/healthz'), {
      method: 'GET',
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
