// MTA-STS + TLS-RPT provisioning and verification.
//
// Background:
//   MTA-STS (RFC 8461) lets a recipient publish a TLS-required policy that
//   sending MTAs cache. The discovery flow is:
//     1. Sender resolves TXT `_mta-sts.{domain}` to learn the policy ID.
//     2. Sender fetches HTTPS `https://mta-sts.{domain}/.well-known/mta-sts.txt`
//        to read the policy itself.
//     3. Sender caches the policy by ID until the next id change.
//
// Polaris layout:
//   - DNS TXT `_mta-sts.{tenant}` — bumped to invalidate sender caches.
//   - HTTPS `mta-sts.{tenant}` — Worker custom domain pointing at
//     polaris-email-api; the Worker route in services/api serves the policy
//     text file (Task C.9). CF Universal SSL handles the cert; we DO NOT
//     publish a CNAME for mta-sts.{tenant} ourselves.
//   - TLS-RPT TXT `_smtp._tls.{tenant}` — reports endpoint for TLS failures.

import type { CloudflareApiClient } from './client.js';
import {
  createRecord,
  deleteRecord,
  findRecord,
  updateRecord,
  type DnsRecordInput,
} from './dns.js';
import { attachCustomDomain, detachCustomDomain } from './workers-routes.js';

/**
 * Compact ISO-8601 timestamp suitable for an MTA-STS policy ID per RFC 8461
 * §3.1 (`1*32(ALPHA / DIGIT)`). Format: `YYYYMMDDTHHMMSSZ` (16 chars).
 *
 * Use the same generated ID for both the DNS TXT and the served policy text;
 * a sender will re-fetch the policy when the TXT id changes.
 */
export function generatePolicyId(d: Date = new Date()): string {
  // Take YYYY-MM-DDTHH:MM:SS from ISO string, strip delimiters → 15 chars,
  // append Z → 16 chars total. Drop milliseconds entirely.
  const iso = d.toISOString(); // e.g. '2026-05-15T12:00:00.000Z'
  const head = iso.slice(0, 19).replace(/[-:]/g, ''); // '20260515T120000'
  return `${head}Z`;
}

/**
 * DNS records that must be published when MTA-STS is enabled for a domain
 * (mode != 'none'). Returns a single TXT record; the `mta-sts.{domain}`
 * hostname is published separately as a Worker custom domain — see
 * `attachCustomDomain` in `./workers-routes.ts`.
 */
export function expectedMtaStsRecords(opts: {
  domain: string;
  policyId: string;
}): DnsRecordInput[] {
  return [
    {
      type: 'TXT',
      name: `_mta-sts.${opts.domain}`,
      content: `v=STSv1; id=${opts.policyId}`,
      comment: 'polaris-email: MTA-STS policy id',
    },
  ];
}

/**
 * DNS record for TLS-RPT (RFC 8460). Senders POST aggregate TLS failure
 * reports to the URI in `rua=`. Multiple URIs may be comma-separated.
 */
export function expectedTlsRptRecord(opts: { domain: string; rua: string }): DnsRecordInput {
  return {
    type: 'TXT',
    name: `_smtp._tls.${opts.domain}`,
    content: `v=TLSRPTv1; rua=${opts.rua}`,
    comment: 'polaris-email: TLS-RPT',
  };
}

export interface ProvisionMtaStsOpts {
  zoneId: string;
  domain: string;
  policyId: string;
  /** Worker script name to attach the mta-sts.{domain} custom domain to. */
  workerName: string;
}

export interface ProvisionResult {
  /** Number of records created or replaced. */
  created: number;
  /** Number of records that already matched and were not touched. */
  skipped: number;
  /** True when the Worker custom domain attach was confirmed (idempotent). */
  customDomainAttached: boolean;
}

async function upsertRecord(
  client: CloudflareApiClient,
  zoneId: string,
  record: DnsRecordInput,
): Promise<'created' | 'skipped'> {
  const existing = await findRecord(client, zoneId, { type: record.type, name: record.name });
  if (!existing) {
    await createRecord(client, zoneId, record);
    return 'created';
  }
  if (existing.content === record.content) {
    return 'skipped';
  }
  // Update in place via PATCH — preserves the record id so cached references
  // (and CF's history) remain stable across policy bumps.
  await updateRecord(client, zoneId, existing.id, record);
  return 'created';
}

async function deleteRecordsByFilter(
  client: CloudflareApiClient,
  zoneId: string,
  filter: { type: string; name: string },
): Promise<void> {
  const existing = await findRecord(client, zoneId, filter);
  if (!existing) return;
  try {
    await deleteRecord(client, zoneId, existing.id);
  } catch {
    // best-effort; let the verifier surface anything we miss.
  }
}

/**
 * Idempotently publish the MTA-STS records for a domain:
 *   1. Upsert the `_mta-sts.{domain}` TXT to the requested policyId.
 *   2. Attach `mta-sts.{domain}` as a Worker custom domain on the zone.
 *
 * Safe to call repeatedly: matching records are skipped, divergent records
 * are PATCHed, missing pieces are created.
 */
export async function provisionMtaSts(
  client: CloudflareApiClient,
  opts: ProvisionMtaStsOpts,
): Promise<ProvisionResult> {
  const expected = expectedMtaStsRecords({ domain: opts.domain, policyId: opts.policyId });
  let created = 0;
  let skipped = 0;
  for (const rec of expected) {
    const outcome = await upsertRecord(client, opts.zoneId, rec);
    if (outcome === 'created') created++;
    else skipped++;
  }
  const dom = await attachCustomDomain(client, {
    zoneId: opts.zoneId,
    hostname: `mta-sts.${opts.domain}`,
    workerName: opts.workerName,
  });
  return { created, skipped, customDomainAttached: !!dom };
}

/**
 * Remove all MTA-STS DNS records + detach the `mta-sts.{domain}` custom
 * domain. Best-effort; no-ops on records that are already gone.
 */
export async function unprovisionMtaSts(
  client: CloudflareApiClient,
  opts: { zoneId: string; domain: string },
): Promise<void> {
  // Use a placeholder policyId — we only need the record name/type for delete.
  const expected = expectedMtaStsRecords({ domain: opts.domain, policyId: 'unused' });
  for (const rec of expected) {
    await deleteRecordsByFilter(client, opts.zoneId, { type: rec.type, name: rec.name });
  }
  try {
    await detachCustomDomain(client, `mta-sts.${opts.domain}`);
  } catch {
    // best-effort
  }
}

/**
 * Idempotently publish the TLS-RPT TXT record. customDomainAttached is always
 * false for TLS-RPT (DNS-only).
 */
export async function provisionTlsRpt(
  client: CloudflareApiClient,
  opts: { zoneId: string; domain: string; rua: string },
): Promise<ProvisionResult> {
  const rec = expectedTlsRptRecord({ domain: opts.domain, rua: opts.rua });
  const outcome = await upsertRecord(client, opts.zoneId, rec);
  return {
    created: outcome === 'created' ? 1 : 0,
    skipped: outcome === 'skipped' ? 1 : 0,
    customDomainAttached: false,
  };
}

export async function unprovisionTlsRpt(
  client: CloudflareApiClient,
  opts: { zoneId: string; domain: string },
): Promise<void> {
  const rec = expectedTlsRptRecord({ domain: opts.domain, rua: 'unused' });
  await deleteRecordsByFilter(client, opts.zoneId, { type: rec.type, name: rec.name });
}
