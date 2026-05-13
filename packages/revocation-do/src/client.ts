// Tenant-side helpers for invoking the per-principal Revocation DO.

import type { RevocationStateResponse } from './revocation-do.js';

export interface DoBindings {
  REVOCATION_DO: {
    idFromName(name: string): { toString(): string };
    get(id: { toString(): string }): { fetch(req: Request): Promise<Response> };
  };
}

function stub(env: DoBindings, principalId: string) {
  return env.REVOCATION_DO.get(env.REVOCATION_DO.idFromName(principalId));
}

export async function revocationCheck(
  env: DoBindings,
  principalId: string
): Promise<RevocationStateResponse> {
  const r = await stub(env, principalId).fetch(new Request('https://do/state'));
  if (!r.ok) {
    throw new Error(`revocation DO state fetch failed: ${r.status}`);
  }
  return (await r.json()) as RevocationStateResponse;
}

export async function revoke(
  env: DoBindings,
  principalId: string,
  by: string,
  reason: string
): Promise<void> {
  const r = await stub(env, principalId).fetch(
    new Request('https://do/revoke', {
      method: 'POST',
      body: JSON.stringify({ by, reason }),
      headers: { 'content-type': 'application/json' },
    })
  );
  if (!r.ok) throw new Error(`revoke failed: ${r.status}`);
}

export async function unrevoke(
  env: DoBindings,
  principalId: string,
  by: string,
  reason: string
): Promise<void> {
  const r = await stub(env, principalId).fetch(
    new Request('https://do/unrevoke', {
      method: 'POST',
      body: JSON.stringify({ by, reason }),
      headers: { 'content-type': 'application/json' },
    })
  );
  if (!r.ok) throw new Error(`unrevoke failed: ${r.status}`);
}
