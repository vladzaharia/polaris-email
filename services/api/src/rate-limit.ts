// Per-API-key per-minute rate limit using a sliding-minute bucket in KV.
import type { Env } from './env.js';

export type RateLimitResult =
  | { ok: true; remaining: number }
  | { ok: false; retryAfterSec: number };

export async function rateLimit(
  env: Env,
  keyId: string,
  perMinute: number,
): Promise<RateLimitResult> {
  return bucketLimit(env, `rl:${keyId}`, perMinute);
}

/**
 * Admin-mutation rate limit — separate prefix so it doesn't compete with
 * the message-send bucket. Default cap is conservative (10/min); enough
 * for any human operator, far below "scripted replay 10k DLQ rows".
 */
export async function adminRateLimit(
  env: Env,
  keyId: string,
  perMinute = 10,
): Promise<RateLimitResult> {
  return bucketLimit(env, `rl-admin:${keyId}`, perMinute);
}

async function bucketLimit(env: Env, prefix: string, perMinute: number): Promise<RateLimitResult> {
  const now = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(now / 60);
  const k = `${prefix}:${bucket}`;
  const raw = await env.KV_RATE_LIMIT.get(k);
  const count = raw ? Number.parseInt(raw, 10) : 0;
  if (count >= perMinute) {
    const retryAfterSec = 60 - (now % 60);
    return { ok: false, retryAfterSec };
  }
  await env.KV_RATE_LIMIT.put(k, String(count + 1), { expirationTtl: 90 });
  return { ok: true, remaining: perMinute - count - 1 };
}
