// Idempotency-Key handling: namespaced by (key_id, idempotency_key), 24h TTL.
// Same body → original response. Different body → 409 idempotency_conflict.
import type { Env } from './env.js';
import { sha256Hex } from './hashing.js';

const TTL_SECONDS = 24 * 60 * 60;

export interface IdempotencyOriginal {
  messageId: string;
  queuedAt: number;
  mode: 'live' | 'test';
  bodySha: string;
}

export async function checkIdempotency(
  env: Env,
  keyId: string,
  idempotencyKey: string | undefined,
  bodyText: string,
): Promise<
  | { state: 'first' }
  | { state: 'replay'; original: IdempotencyOriginal }
  | { state: 'conflict' }
> {
  if (!idempotencyKey) return { state: 'first' };
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) {
    // Treat malformed key as if not provided to avoid creating a poison entry.
    return { state: 'first' };
  }
  const k = `idem:${keyId}:${idempotencyKey}`;
  const existing = await env.KV_IDEMPOTENCY.get(k, 'json').catch(() => null);
  const sha = await sha256Hex(bodyText);
  if (!existing) return { state: 'first' };
  const orig = existing as IdempotencyOriginal;
  if (orig.bodySha !== sha) return { state: 'conflict' };
  return { state: 'replay', original: orig };
}

export async function recordIdempotency(
  env: Env,
  keyId: string,
  idempotencyKey: string | undefined,
  bodyText: string,
  original: Omit<IdempotencyOriginal, 'bodySha'>,
): Promise<void> {
  if (!idempotencyKey) return;
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) return;
  const k = `idem:${keyId}:${idempotencyKey}`;
  const sha = await sha256Hex(bodyText);
  await env.KV_IDEMPOTENCY.put(
    k,
    JSON.stringify({ ...original, bodySha: sha }),
    { expirationTtl: TTL_SECONDS },
  );
}
