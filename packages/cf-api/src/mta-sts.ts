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

import type { DnsRecordInput } from './dns.js';

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
