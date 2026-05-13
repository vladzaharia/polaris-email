import type { CloudflareApiClient } from './client.js';
import {
  createRecord,
  deleteRecord,
  findRecord,
  type DnsRecordInput,
} from './dns.js';
import type { ExpectedRecord } from './types.js';

export interface OnboardSenderDomainOpts {
  zoneId: string;
  domain: string;
  /** Selector for the DKIM CNAME alias. Defaults to `cf` */
  dkimSelector?: string;
  /** When true (default), publish wildcard DKIM CNAME for *._domainkey */
  wildcardDkim?: boolean;
  /** Override the cf-bounce MX target */
  bounceMxTarget?: string;
  /** Override the DKIM CNAME target host */
  dkimTarget?: string;
}

export interface OnboardResult {
  dnsRecords: DnsRecordInput[];
}

/**
 * Publishes the canonical DNS records for a Cloudflare Email Service sender
 * domain.
 *
 * Note (2026-05): the Email Service onboarding endpoint is still in beta and
 * not exposed as a stable public API. This implementation publishes the
 * functionally-equivalent records via the DNS API:
 *  - DKIM CNAME (selector + optional wildcard) -> `<sel>.<dkimTarget>`
 *  - SPF TXT  (`v=spf1 include:_spf.mx.cloudflare.net -all`)
 *  - DMARC TXT (`v=DMARC1; p=quarantine; rua=mailto:dmarc@<domain>`)
 *  - cf-bounce MX (priority 10 -> route.mx.cloudflare.net)
 */
export async function onboardSenderDomain(
  client: CloudflareApiClient,
  opts: OnboardSenderDomainOpts,
): Promise<OnboardResult> {
  const records = expectedRecordsFor(opts);
  const created: DnsRecordInput[] = [];
  for (const r of records) {
    // Idempotent: if a record with the same name+type already exists, skip.
    const existing = await findRecord(client, opts.zoneId, { type: r.type, name: r.name });
    if (existing && existing.content === r.content) {
      created.push(r);
      continue;
    }
    if (existing) {
      // Conflict on name+type but different content: leave it untouched and
      // surface via verifyOnboarding rather than blowing up onboarding.
      created.push(r);
      continue;
    }
    await createRecord(client, opts.zoneId, r);
    created.push(r);
  }
  return { dnsRecords: created };
}

export async function verifyOnboarding(
  client: CloudflareApiClient,
  zoneId: string,
  domain: string,
  opts: { dkimSelector?: string; resolverFetch?: typeof fetch } = {},
): Promise<{ verified: boolean; missing: string[] }> {
  const expected = expectedRecordsFor({ zoneId, domain, dkimSelector: opts.dkimSelector });
  const missing: string[] = [];
  for (const r of expected) {
    const existing = await findRecord(client, zoneId, { type: r.type, name: r.name });
    if (!existing) {
      missing.push(`${r.type} ${r.name}`);
      continue;
    }
    if (!matchesContent(existing.content, r.content)) {
      missing.push(`${r.type} ${r.name} (content mismatch)`);
    }
  }
  return { verified: missing.length === 0, missing };
}

export async function unboardSenderDomain(
  client: CloudflareApiClient,
  zoneId: string,
  domain: string,
  opts: { dkimSelector?: string } = {},
): Promise<void> {
  const expected = expectedRecordsFor({ zoneId, domain, dkimSelector: opts.dkimSelector });
  for (const r of expected) {
    const existing = await findRecord(client, zoneId, { type: r.type, name: r.name });
    if (!existing) continue;
    try {
      await deleteRecord(client, zoneId, existing.id);
    } catch {
      // best-effort
    }
  }
}

export function expectedRecordsFor(opts: OnboardSenderDomainOpts): DnsRecordInput[] {
  const selector = opts.dkimSelector ?? 'cf';
  const wildcard = opts.wildcardDkim ?? true;
  const dkimTargetBase = opts.dkimTarget ?? `${opts.domain}.dkim.cfemail.net`;
  const bounceMx = opts.bounceMxTarget ?? 'route.mx.cloudflare.net';
  const recs: DnsRecordInput[] = [
    {
      type: 'CNAME',
      name: `${selector}._domainkey.${opts.domain}`,
      content: `${selector}.${dkimTargetBase}`,
      comment: 'polaris-email: DKIM',
    },
    {
      type: 'TXT',
      name: opts.domain,
      content: 'v=spf1 include:_spf.mx.cloudflare.net -all',
      comment: 'polaris-email: SPF',
    },
    {
      type: 'TXT',
      name: `_dmarc.${opts.domain}`,
      content: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${opts.domain}`,
      comment: 'polaris-email: DMARC',
    },
    {
      type: 'MX',
      name: `cf-bounce.${opts.domain}`,
      content: bounceMx,
      priority: 10,
      comment: 'polaris-email: bounce',
    },
  ];
  if (wildcard) {
    recs.push({
      type: 'CNAME',
      name: `*._domainkey.${opts.domain}`,
      content: `${selector}._domainkey.${opts.domain}`,
      comment: 'polaris-email: DKIM wildcard',
    });
  }
  return recs;
}

export function asExpectedRecords(records: DnsRecordInput[]): ExpectedRecord[] {
  return records.map((r) => ({ type: r.type, name: r.name, content: r.content }));
}

function matchesContent(actual: string, expected: string): boolean {
  return normalize(actual) === normalize(expected);
}

function normalize(s: string): string {
  return s.replace(/^"|"$/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}
