// Discovery + diff engine tests. Mocks CloudflareApiClient with canned
// responses for: (1) a fully-configured zone (computeDiff returns []), (2) an
// unconfigured zone (returns 4 ops), (3) a partially-configured zone, and
// (4) applyDiff with one op failing while others succeed.
import { describe, it, expect } from 'vitest';
import { CloudflareApiClient } from '../src/client.js';
import {
  computeDiff,
  inspectZone,
  applyDiff,
  type ApplyEnv,
  type InspectorEnv,
  type ZoneDomainStatus,
} from '../src/discovery.js';
import type { Zone } from '../src/types.js';

function makeClient(routes: Record<string, (method: string, body?: unknown) => Response>) {
  const fetchImpl: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const path = url.replace('https://api.cloudflare.com/client/v4', '');
    const method = init?.method ?? 'GET';
    const handler = routes[`${method} ${path}`] ?? routes[`* ${path}`];
    if (!handler) {
      return new Response('{"success":false,"errors":[{"code":7003,"message":"not found"}]}', {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    let body: unknown;
    if (init?.body) {
      try {
        body = JSON.parse(init.body as string);
      } catch {
        body = init.body;
      }
    }
    return handler(method, body);
  }) as typeof fetch;
  return new CloudflareApiClient({ apiToken: 't', accountId: 'acc', fetchImpl, maxRetries: 0 });
}

function ok(result: unknown): Response {
  return new Response(JSON.stringify({ success: true, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const ZONE_FULL: Zone = { id: 'z1', name: 'plrs.im' };
const ZONE_BARE: Zone = { id: 'z2', name: 'example.com' };

/**
 * Build a DoH resolver that returns the canonical expected content for each
 * polaris-mail sender record on the given domain. Matches `expectedRecordsFor`
 * in `email-service.ts`: cf._domainkey CNAME, *._domainkey CNAME (wildcard),
 * SPF TXT, DMARC TXT, cf-bounce MX.
 */
function dohResolverFor(domain: string): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const params = new URLSearchParams(url.split('?')[1] ?? '');
    const name = params.get('name') ?? '';
    const type = params.get('type') ?? '';
    const data = (() => {
      // Wildcard DKIM CNAME points at the cf._domainkey record.
      if (type === 'CNAME' && name === `*._domainkey.${domain}`) return `cf._domainkey.${domain}`;
      // Primary DKIM CNAME points at CF's hosted DKIM target.
      if (type === 'CNAME' && name === `cf._domainkey.${domain}`)
        return `cf.${domain}.dkim.cfemail.net`;
      if (type === 'TXT' && name === `_dmarc.${domain}`)
        return `v=DMARC1; p=quarantine; rua=mailto:dmarc@${domain}`;
      if (type === 'TXT' && name === domain) return 'v=spf1 include:_spf.mx.cloudflare.net -all';
      if (type === 'MX' && name === `cf-bounce.${domain}`) return 'route.mx.cloudflare.net';
      return '';
    })();
    return new Response(JSON.stringify({ Answer: data ? [{ type: 1, data }] : [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

function dohResolverThatResolvesNothing(): typeof fetch {
  return (async () =>
    new Response('{"Answer":[]}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}

const inboundWorkerName = 'polaris-mail-in';

describe('inspectZone — fully configured', () => {
  it('reports overall=ok when every check passes', async () => {
    // The three GET /zones/z1/dns_records?... handlers below mock CF's
    // zone DNS API for the cf-bounce.<domain> records that
    // `checkSenderOnboardedViaCf` reads to determine `sender_onboarded`.
    // Email Sending publishes MX + SPF + DKIM on the cf-bounce
    // subdomain, distinct from Email Routing's apex records.
    const client = makeClient({
      'GET /zones/z1/email/routing': () => ok({ enabled: true, status: 'ready', name: 'plrs.im' }),
      'GET /zones/z1/email/routing/dns': () =>
        ok({
          errors: [],
          records: [
            {
              type: 'MX',
              name: 'plrs.im',
              content: 'route1.mx.cloudflare.net',
              required: true,
              locked: true,
            },
            { type: 'TXT', name: 'plrs.im', content: 'v=spf1 ...', required: true, locked: true },
          ],
        }),
      'GET /zones/z1/dns_records?type=MX&name=cf-bounce.plrs.im': () =>
        ok([
          {
            id: 'r-mx',
            type: 'MX',
            name: 'cf-bounce.plrs.im',
            content: 'route.mx.cloudflare.net',
          },
        ]),
      'GET /zones/z1/dns_records?type=TXT&name=cf-bounce.plrs.im': () =>
        ok([
          {
            id: 'r-spf',
            type: 'TXT',
            name: 'cf-bounce.plrs.im',
            content: 'v=spf1 include:_spf.mx.cloudflare.net -all',
          },
        ]),
      'GET /zones/z1/dns_records?type=TXT&name=cf-bounce._domainkey.plrs.im': () =>
        ok([
          {
            id: 'r-dkim',
            type: 'TXT',
            name: 'cf-bounce._domainkey.plrs.im',
            content: 'v=DKIM1; k=rsa; p=...',
          },
        ]),
      'GET /zones/z1/email/routing/rules': () => ok([]),
      'GET /zones/z1/email/routing/rules/catch_all': () =>
        ok({
          name: 'catch-all',
          enabled: true,
          matchers: [{ type: 'all' }],
          actions: [{ type: 'worker', value: ['polaris-mail-in'] }],
        }),
    });
    const env: InspectorEnv = {
      inboundWorkerName,
      d1HasMailDomain: async () => true,
      dohFetch: dohResolverFor(ZONE_FULL.name),
    };
    const status = await inspectZone(client, ZONE_FULL, env);
    expect(status.overall).toBe('ok');
    expect(status.routing_enabled).toBe(true);
    expect(status.routing_status_ok).toBe(true);
    expect(status.dns_records_locked).toBe(true);
    expect(status.catch_all_correct).toBe(true);
    expect(status.sender_onboarded).toBe(true);
    expect(status.d1_mail_domain_exists).toBe(true);
  });

  it('produces empty diff when fully converged', () => {
    const status: ZoneDomainStatus = {
      zone: ZONE_FULL,
      routing_enabled: true,
      routing_status: 'ready',
      routing_status_ok: true,
      dns_records_locked: true,
      dns_record_errors: [],
      sender_onboarded: true,
      sender_missing_records: [],
      catch_all_target: 'worker:polaris-mail-in',
      catch_all_correct: true,
      named_rules: [],
      has_conflicting_rules: false,
      d1_mail_domain_exists: true,
      overall: 'ok',
      error: null,
    };
    const diff = computeDiff(status, { inboundWorkerName });
    expect(diff.ops).toEqual([]);
    expect(diff.warnings).toEqual([]);
  });
});

describe('inspectZone — unconfigured', () => {
  it('reports overall=unconfigured and produces 4 ops', async () => {
    const client = makeClient({
      'GET /zones/z2/email/routing': () => ok({ enabled: false, status: 'unconfigured' }),
      // Routing isn't enabled, so the DNS + catch-all endpoints aren't queried.
    });
    const env: InspectorEnv = {
      inboundWorkerName,
      d1HasMailDomain: async () => false,
      dohFetch: dohResolverThatResolvesNothing(),
    };
    const status = await inspectZone(client, ZONE_BARE, env);
    expect(status.routing_enabled).toBe(false);
    expect(status.sender_onboarded).toBe(false);
    expect(status.d1_mail_domain_exists).toBe(false);
    expect(status.overall).toBe('unconfigured');

    const diff = computeDiff(status, { inboundWorkerName });
    expect(diff.ops.map((o) => o.kind)).toEqual([
      'enable_routing',
      'set_catch_all_worker',
      'onboard_sender_domain',
      'create_d1_mail_domain',
    ]);
  });
});

describe('inspectZone — partially configured', () => {
  it('reports overall=partial when routing is on but catch-all is wrong', async () => {
    const client = makeClient({
      'GET /zones/z1/email/routing': () => ok({ enabled: true, status: 'ready', name: 'plrs.im' }),
      'GET /zones/z1/email/routing/dns': () =>
        ok({
          errors: [],
          records: [{ type: 'MX', name: 'plrs.im', content: 'r.mx', required: true, locked: true }],
        }),
      // Email Sending records present so this test isolates the catch-all
      // problem (otherwise `sender_onboarded` would also be false and the
      // computed diff would include onboard_sender_domain as a second op).
      'GET /zones/z1/dns_records?type=MX&name=cf-bounce.plrs.im': () =>
        ok([
          {
            id: 'r-mx',
            type: 'MX',
            name: 'cf-bounce.plrs.im',
            content: 'route.mx.cloudflare.net',
          },
        ]),
      'GET /zones/z1/dns_records?type=TXT&name=cf-bounce.plrs.im': () =>
        ok([
          {
            id: 'r-spf',
            type: 'TXT',
            name: 'cf-bounce.plrs.im',
            content: 'v=spf1 include:_spf.mx.cloudflare.net -all',
          },
        ]),
      'GET /zones/z1/dns_records?type=TXT&name=cf-bounce._domainkey.plrs.im': () =>
        ok([
          {
            id: 'r-dkim',
            type: 'TXT',
            name: 'cf-bounce._domainkey.plrs.im',
            content: 'v=DKIM1; k=rsa; p=...',
          },
        ]),
      'GET /zones/z1/email/routing/rules': () => ok([]),
      'GET /zones/z1/email/routing/rules/catch_all': () =>
        ok({
          name: 'catch-all',
          enabled: true,
          matchers: [{ type: 'all' }],
          actions: [{ type: 'forward', value: ['someone@elsewhere.com'] }],
        }),
    });
    const env: InspectorEnv = {
      inboundWorkerName,
      d1HasMailDomain: async () => true,
      dohFetch: dohResolverFor(ZONE_FULL.name),
    };
    const status = await inspectZone(client, ZONE_FULL, env);
    expect(status.overall).toBe('partial');
    expect(status.catch_all_correct).toBe(false);
    expect(status.catch_all_target).toBe('forward:someone@elsewhere.com');

    const diff = computeDiff(status, { inboundWorkerName });
    expect(diff.ops.map((o) => o.kind)).toEqual(['set_catch_all_worker']);
  });
});

describe('applyDiff', () => {
  it('runs each op in order; one failure does not abort others', async () => {
    const client = makeClient({
      // enable_routing succeeds
      'POST /zones/z2/email/routing/enable': () => ok({}),
      // set_catch_all_worker FAILS
      'PUT /zones/z2/email/routing/rules/catch_all': () =>
        new Response('{"success":false,"errors":[{"code":1234,"message":"forbidden"}]}', {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
      // onboard_sender_domain succeeds
      'POST /accounts/acc/email-service/sender-domains': () => ok({}),
    });
    const env: ApplyEnv = {
      inboundWorkerName,
      d1HasMailDomain: async () => false,
      d1InsertMailDomain: async () => undefined,
    };
    const result = await applyDiff(
      client,
      {
        zone: ZONE_BARE,
        current: {} as ZoneDomainStatus,
        ops: [
          { kind: 'enable_routing', description: '' },
          { kind: 'set_catch_all_worker', description: '' },
          { kind: 'onboard_sender_domain', description: '' },
          { kind: 'create_d1_mail_domain', description: '' },
        ],
        warnings: [],
      },
      env,
    );
    expect(result.applied.map((o) => o.kind)).toEqual([
      'enable_routing',
      'onboard_sender_domain',
      'create_d1_mail_domain',
    ]);
    expect(result.failed.map((f) => f.op.kind)).toEqual(['set_catch_all_worker']);
    expect(result.failed[0]?.error).toContain('forbidden');
  });
});

describe('inspectZone — Email Routing on, Email Sending off', () => {
  // Regression test for the polaris.gdn false-positive: a domain with CF
  // Email Routing fully configured (apex MX / SPF / cf2024-N._domainkey)
  // but Email Sending NOT onboarded (no cf-bounce.<domain> records).
  // Pre-fix, sender_onboarded was wrongly `true` because the heuristic
  // treated routing DNS records as evidence of sender onboarding.
  it('reports sender_onboarded=false when cf-bounce records are absent', async () => {
    const client = makeClient({
      'GET /zones/z1/email/routing': () => ok({ enabled: true, status: 'ready', name: 'plrs.im' }),
      'GET /zones/z1/email/routing/dns': () =>
        ok({
          errors: [],
          records: [
            { type: 'MX', name: 'plrs.im', content: 'route1.mx.cloudflare.net', required: true },
            { type: 'TXT', name: 'plrs.im', content: 'v=spf1 ...', required: true },
            {
              type: 'TXT',
              name: 'cf2024-1._domainkey.plrs.im',
              content: 'v=DKIM1; k=rsa; p=...',
              required: true,
            },
          ],
        }),
      // No cf-bounce.<domain> records → CF DNS returns empty arrays.
      'GET /zones/z1/dns_records?type=MX&name=cf-bounce.plrs.im': () => ok([]),
      'GET /zones/z1/dns_records?type=TXT&name=cf-bounce.plrs.im': () => ok([]),
      'GET /zones/z1/dns_records?type=TXT&name=cf-bounce._domainkey.plrs.im': () => ok([]),
      'GET /zones/z1/email/routing/rules': () => ok([]),
      'GET /zones/z1/email/routing/rules/catch_all': () =>
        ok({
          name: 'catch-all',
          enabled: true,
          matchers: [{ type: 'all' }],
          actions: [{ type: 'worker', value: ['polaris-mail-in'] }],
        }),
    });
    const env: InspectorEnv = {
      inboundWorkerName,
      d1HasMailDomain: async () => true,
      dohFetch: dohResolverThatResolvesNothing(),
    };
    const status = await inspectZone(client, ZONE_FULL, env);
    expect(status.routing_enabled).toBe(true);
    expect(status.routing_status_ok).toBe(true);
    expect(status.sender_onboarded).toBe(false);
    expect(status.sender_missing_records).toContain('MX cf-bounce.plrs.im (not present in zone)');
    // Overall is partial since routing/catch-all/d1 pass but sender fails.
    expect(status.overall).toBe('partial');
    // The diff should include onboard_sender_domain as the remediation.
    const diff = computeDiff(status, { inboundWorkerName });
    expect(diff.ops.map((o) => o.kind)).toContain('onboard_sender_domain');
  });
});

describe('inspectZone — CF API error path', () => {
  it('reports overall=error when getEmailRoutingSettings throws', async () => {
    // No routes registered → every CF call returns 404 → settings call throws,
    // caught by inspectZone, reported via `error`.
    const client = makeClient({});
    const env: InspectorEnv = {
      inboundWorkerName,
      d1HasMailDomain: async () => false,
      dohFetch: dohResolverThatResolvesNothing(),
    };
    const status = await inspectZone(client, ZONE_BARE, env);
    expect(status.overall).toBe('error');
    expect(status.error).toBeTruthy();
  });
});
