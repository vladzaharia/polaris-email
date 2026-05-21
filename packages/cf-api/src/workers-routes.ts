// Cloudflare Workers Custom Domains REST API helpers.
//
// Custom Domains attach a Worker to a domain or subdomain within a Cloudflare
// zone. CF auto-creates the necessary A/AAAA records and Universal SSL cert.
//
// Polaris uses this to publish `mta-sts.{tenant}` for each onboarded sender
// domain, routing requests to the central `polaris-mail-api` Worker which
// serves the MTA-STS policy text file (see services/api MTA-STS route).
//
// API surface (per https://developers.cloudflare.com/api/resources/workers/subresources/domains/):
//   PUT    /accounts/{accountId}/workers/domains          { hostname, service, zone_id, environment? }
//   GET    /accounts/{accountId}/workers/domains?hostname={h}
//   DELETE /accounts/{accountId}/workers/domains/{domainId}

import { z } from 'zod';
import type { CloudflareApiClient } from './client.js';

export interface WorkerCustomDomain {
  id: string;
  hostname: string;
  zoneId: string;
  service: string;
  environment?: string;
}

export interface AttachCustomDomainOpts {
  zoneId: string;
  hostname: string;
  workerName: string;
  environment?: string;
}

// CF returns `zone_id` (snake_case). Normalize to camelCase at the boundary.
const CfWorkerDomainSchema = z.object({
  id: z.string(),
  hostname: z.string(),
  zone_id: z.string(),
  service: z.string(),
  environment: z.string().optional(),
});

function fromCfShape(raw: z.infer<typeof CfWorkerDomainSchema>): WorkerCustomDomain {
  const out: WorkerCustomDomain = {
    id: raw.id,
    hostname: raw.hostname,
    zoneId: raw.zone_id,
    service: raw.service,
  };
  if (raw.environment !== undefined) out.environment = raw.environment;
  return out;
}

/**
 * Locate a Worker custom domain by hostname. Returns null when not found.
 * Used as the idempotency probe for `attachCustomDomain` and `detachCustomDomain`.
 */
export async function findCustomDomain(
  client: CloudflareApiClient,
  hostname: string,
): Promise<WorkerCustomDomain | null> {
  const params = new URLSearchParams({ hostname });
  const path = `/accounts/${client.accountId}/workers/domains?${params.toString()}`;
  const list = await client.get(path, z.array(CfWorkerDomainSchema));
  const match = list.find((d) => d.hostname === hostname) ?? list[0];
  return match ? fromCfShape(match) : null;
}

/**
 * Attach a custom domain to a Worker. Idempotent: when a domain with the same
 * hostname already exists pointing at the same worker + zone, returns it
 * without issuing a PUT.
 *
 * NOTE: when an existing domain points at a *different* worker or zone, this
 * function still returns the existing domain (no overwrite). Callers that want
 * to repoint should `detachCustomDomain` first.
 */
export async function attachCustomDomain(
  client: CloudflareApiClient,
  opts: AttachCustomDomainOpts,
): Promise<WorkerCustomDomain> {
  const existing = await findCustomDomain(client, opts.hostname);
  if (existing && existing.service === opts.workerName && existing.zoneId === opts.zoneId) {
    return existing;
  }
  const body: {
    hostname: string;
    service: string;
    zone_id: string;
    environment?: string;
  } = {
    hostname: opts.hostname,
    service: opts.workerName,
    zone_id: opts.zoneId,
  };
  if (opts.environment !== undefined) body.environment = opts.environment;
  const path = `/accounts/${client.accountId}/workers/domains`;
  const raw = await client.put(path, body, CfWorkerDomainSchema);
  return fromCfShape(raw);
}

/**
 * Detach the custom domain matching `hostname` from its Worker. No-op when no
 * matching domain exists, so callers can re-run on partial-failure recovery.
 */
export async function detachCustomDomain(
  client: CloudflareApiClient,
  hostname: string,
): Promise<void> {
  const existing = await findCustomDomain(client, hostname);
  if (!existing) return;
  await client.delete(`/accounts/${client.accountId}/workers/domains/${existing.id}`);
}
