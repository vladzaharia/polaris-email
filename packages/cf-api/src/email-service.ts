// Cloudflare Email Service onboarding helpers.
//
// IMPORTANT (operator clarification, 2026-05): Cloudflare manages the DNS for
// us automatically. When Email Routing is enabled on a zone, CF auto-publishes
// the inbound MX records (`route1/2/3.mx.cloudflare.net`). When a domain is
// onboarded with Email Service, CF auto-publishes the DKIM CNAMEs, the SPF
// `_spf.mx.cloudflare.net` include, the cf-bounce MX, and a DMARC record.
//
// Our job is therefore *verify*, not *create*. The functions below:
//   1. Ask the Email Service onboarding endpoint to onboard the domain
//      (which causes CF to publish the records on its side).
//   2. Return the *expected* records so the caller knows what to confirm.
//   3. Provide `verifyOnboarding()` which DoH-checks each expected record
//      via the public resolvers.
//
// We retain `unboardSenderDomain()` and the dns.ts create/update/delete
// helpers for two edge cases: (a) operators who run their own DNS provider
// where CF can't auto-publish, and (b) custom records (e.g., per-tenant
// DMARC `rua=` mailbox) that need surgical adjustments.

import type { CloudflareApiClient } from './client.js';
import { createRecord, deleteRecord, findRecord, type DnsRecordInput } from './dns.js';
import type { ExpectedRecord } from './types.js';

export interface OnboardSenderDomainOpts {
  zoneId: string;
  domain: string;
  /** Selector for the DKIM CNAME alias. CF chooses this when not provided. */
  dkimSelector?: string;
  /** When true (default), expect a wildcard DKIM CNAME for *._domainkey */
  wildcardDkim?: boolean;
  /** Override the cf-bounce MX target. */
  bounceMxTarget?: string;
  /** Override the DKIM CNAME target host. */
  dkimTarget?: string;
  /**
   * When true (default), call the Email Service onboarding endpoint and let
   * Cloudflare publish DNS. When false, fall back to the manual-publish path
   * (used by operators on non-CF DNS).
   */
  cfManagedDns?: boolean;
}

export interface OnboardResult {
  /** Records that CF has published or will publish. */
  expectedRecords: DnsRecordInput[];
  /** True when CF was asked to manage the DNS itself. */
  cfManaged: boolean;
}

/**
 * Onboard a sender domain. By default, asks Cloudflare to manage DNS itself
 * (the standard path). The function returns the records to verify.
 *
 * NOTE: as of 2026-05 the Email Service onboarding endpoint is in beta. The
 * Confirmed by manual probing:
 * the exact URL and payload shape; until that's run, this function falls
 * back to the manual-publish path with a logged warning.
 */
export async function onboardSenderDomain(
  client: CloudflareApiClient,
  opts: OnboardSenderDomainOpts,
): Promise<OnboardResult> {
  const cfManaged = opts.cfManagedDns ?? true;
  const expected = expectedRecordsFor(opts);

  if (cfManaged) {
    // Try the Email Service onboarding endpoint first. The exact path is
    // If the endpoint 404s or 405s, fall through to the
    // manual-publish path.
    try {
      await client.post(`/accounts/${client.accountId}/email-service/sender-domains`, {
        domain: opts.domain,
        dkim_selector: opts.dkimSelector,
        wildcard_dkim: opts.wildcardDkim ?? true,
      });
      return { expectedRecords: expected, cfManaged: true };
    } catch (err) {
      // 404 / 405 / 501 from the API => endpoint not yet GA on this account.
      // Fall through to manual publish so onboarding still completes.
      //
      // 4a.11: log this fallback. Silent degradation hid endpoint URL
      // changes / token-permission regressions for weeks at a time. The
      // warning gives operators a single grep target ("email-service:
      // onboarding endpoint unavailable") that surfaces in the logs of
      // every degraded onboarding.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/^4(0[45]|18)|^501/.test(msg)) {
        throw err;
      }
      // eslint-disable-next-line no-console
      console.warn(
        'email-service: onboarding endpoint unavailable, falling back to manual publish',
        { domain: opts.domain, error: msg },
      );
    }
  }

  // Manual-publish path (non-CF DNS, or Email Service endpoint unavailable).
  for (const r of expected) {
    const existing = await findRecord(client, opts.zoneId, { type: r.type, name: r.name });
    if (existing && existing.content === r.content) continue;
    if (existing) continue; // leave conflicts for verifyOnboarding to surface
    await createRecord(client, opts.zoneId, r);
  }
  return { expectedRecords: expected, cfManaged: false };
}

/**
 * Confirm via DoH that all expected records are visible from the public
 * internet. This is the primary verification path because Cloudflare may
 * publish records asynchronously after onboarding.
 *
 * `dohFetch` defaults to fetching against 1.1.1.1 (Cloudflare's resolver).
 * Inject a different resolver in tests.
 */
export async function verifyOnboarding(
  _client: CloudflareApiClient,
  zoneId: string,
  domain: string,
  opts: {
    dkimSelector?: string;
    wildcardDkim?: boolean;
    bounceMxTarget?: string;
    dkimTarget?: string;
    /** Override DoH resolver fetch (test injection). */
    dohFetch?: typeof fetch;
  } = {},
): Promise<{ verified: boolean; missing: string[] }> {
  const expected = expectedRecordsFor({
    zoneId,
    domain,
    dkimSelector: opts.dkimSelector,
    wildcardDkim: opts.wildcardDkim,
    bounceMxTarget: opts.bounceMxTarget,
    dkimTarget: opts.dkimTarget,
  });
  const fetchImpl = opts.dohFetch ?? fetch;
  const missing: string[] = [];
  for (const r of expected) {
    const found = await dohResolve(fetchImpl, r.name, r.type);
    if (found.length === 0) {
      missing.push(`${r.type} ${r.name} (no records resolved)`);
      continue;
    }
    if (!found.some((value) => matchesContent(value, r.content))) {
      missing.push(`${r.type} ${r.name} (content mismatch; got: ${found[0]})`);
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
      comment: 'polaris-mail: DKIM (CF-managed)',
    },
    {
      type: 'TXT',
      name: opts.domain,
      content: 'v=spf1 include:_spf.mx.cloudflare.net -all',
      comment: 'polaris-mail: SPF (CF-managed)',
    },
    {
      type: 'TXT',
      name: `_dmarc.${opts.domain}`,
      content: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${opts.domain}`,
      comment: 'polaris-mail: DMARC',
    },
    {
      type: 'MX',
      name: `cf-bounce.${opts.domain}`,
      content: bounceMx,
      priority: 10,
      comment: 'polaris-mail: bounce (CF-managed)',
    },
  ];
  if (wildcard) {
    recs.push({
      type: 'CNAME',
      name: `*._domainkey.${opts.domain}`,
      content: `${selector}._domainkey.${opts.domain}`,
      comment: 'polaris-mail: DKIM wildcard',
    });
  }
  return recs;
}

export function asExpectedRecords(records: DnsRecordInput[]): ExpectedRecord[] {
  return records.map((r) => ({ type: r.type, name: r.name, content: r.content }));
}

/** Resolve a name via DoH against 1.1.1.1; returns array of `data` strings. */
async function dohResolve(fetchImpl: typeof fetch, name: string, type: string): Promise<string[]> {
  try {
    const url = `https://1.1.1.1/dns-query?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`;
    const r = await fetchImpl(url, { headers: { accept: 'application/dns-json' } });
    if (!r.ok) return [];
    const j = (await r.json()) as { Answer?: { type: number; data: string }[] };
    return (j.Answer ?? []).map((a) => a.data);
  } catch {
    return [];
  }
}

function matchesContent(actual: string, expected: string): boolean {
  return normalize(actual) === normalize(expected);
}

function normalize(s: string): string {
  return s.replace(/^"|"$/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}
