// Per-minute: liveness probe against the API's /healthz. Alerts after two
// consecutive failures.
//
// The consecutive-failure counter is persisted to KV_RATE_LIMIT (under
// `synthetic:consecutive_failures`, 30-minute TTL) instead of an in-memory
// `let`. CF Worker isolates can be evicted between cron ticks, which would
// reset a module-level counter to 0 on every cold start and silently mask a
// sustained outage. The KV write is a single small string so the cost is
// negligible.
//
// Outbound alert posts route through `safeFetch` so a misconfigured
// `ALERT_WEBHOOK` can't be repurposed as an SSRF probe.
import type { Env } from '../env.js';
import { safeFetch } from '../queue/ssrf.js';

const SYNTHETIC_COUNTER_KEY = 'synthetic:consecutive_failures';
const SYNTHETIC_COUNTER_TTL_SECONDS = 30 * 60;
const ALERT_THRESHOLD = 2;

async function readCounter(env: Env): Promise<number> {
  try {
    const raw = await env.KV_RATE_LIMIT.get(SYNTHETIC_COUNTER_KEY);
    if (!raw) return 0;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

async function writeCounter(env: Env, n: number): Promise<void> {
  try {
    if (n === 0) {
      await env.KV_RATE_LIMIT.delete(SYNTHETIC_COUNTER_KEY);
      return;
    }
    await env.KV_RATE_LIMIT.put(SYNTHETIC_COUNTER_KEY, String(n), {
      expirationTtl: SYNTHETIC_COUNTER_TTL_SECONDS,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('synthetic: KV counter write failed', e instanceof Error ? e.message : 'unknown');
  }
}

export async function synthetic(env: Env): Promise<void> {
  const ok = await runOnce(env);
  const prev = await readCounter(env);
  const next = ok ? 0 : prev + 1;
  await writeCounter(env, next);
  if (next >= ALERT_THRESHOLD && env.ALERT_WEBHOOK) {
    try {
      await safeFetch(env.ALERT_WEBHOOK, 'external', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          service: 'polaris-email',
          synthetic_failures: next,
        }),
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('synthetic alert failed', e);
    }
  }
}

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
    const limit = env.MAX_LATENCY_MS ? Number.parseInt(env.MAX_LATENCY_MS, 10) : 300_000;
    if (dt > limit) {
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
