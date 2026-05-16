// Shared R2 read helper. Returns the object body as a `Uint8Array` or `null`
// if the key is missing. Centralised so every route's "load the canonical
// MIME bytes for a stored message" path uses the same code; the previous
// inline copies in `routes/messages.ts` + `routes/messages-state.ts` drifted
// independently across phases.
import type { Env } from '../env.js';

export async function loadR2Bytes(env: Env, key: string): Promise<Uint8Array | null> {
  const obj = await env.R2.get(key);
  if (!obj) return null;
  const buf = await obj.arrayBuffer();
  return new Uint8Array(buf);
}
