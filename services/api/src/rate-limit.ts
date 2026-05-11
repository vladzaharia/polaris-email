// Per-API-key per-minute rate limit using a sliding-minute bucket in KV.
import type { Env } from './env.js';

export async function rateLimit(
  env: Env,
  keyId: string,
  perMinute: number,
): Promise<{ ok: true; remaining: number } | { ok: false; retryAfterSec: number }> {
  const now = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(now / 60);
  const k = `rl:${keyId}:${bucket}`;
  const raw = await env.KV_RATE_LIMIT.get(k);
  const count = raw ? Number.parseInt(raw, 10) : 0;
  if (count >= perMinute) {
    const retryAfterSec = 60 - (now % 60);
    return { ok: false, retryAfterSec };
  }
  await env.KV_RATE_LIMIT.put(k, String(count + 1), { expirationTtl: 90 });
  return { ok: true, remaining: perMinute - count - 1 };
}
