// CF-zones-list smoke test.
//
// Mirrors the constraint of `mailboxes-list.test.ts`: no DOM available, so we
// exercise the panel proxy contract (the JSON the page reads) rather than
// mounting React. Verifies the `/v1/admin/cf-zones` envelope flows through
// `makePolaris` unchanged and that the page-side type predicates can pluck the
// six per-zone status flags out of the response.
import { describe, expect, it } from 'vitest';
import { makePolaris } from '../src/server/polaris.js';
import type { Env } from '../src/server/env.js';
import type { CfZoneListResponse, ZoneDomainStatus } from '../src/client/pages/cf-zones/types.js';

function fakeZone(name: string, partial: Partial<ZoneDomainStatus> = {}): ZoneDomainStatus {
  return {
    zone: { id: 'cf-' + name, name, status: 'active' },
    routing_enabled: true,
    routing_status: 'ready',
    routing_status_ok: true,
    dns_records_locked: true,
    dns_record_errors: [],
    sender_onboarded: true,
    sender_missing_records: [],
    catch_all_target: 'polaris-email-in',
    catch_all_correct: true,
    named_rules: [],
    has_conflicting_rules: false,
    d1_mail_domain_exists: true,
    overall: 'ok',
    error: null,
    ...partial,
  };
}

describe('CF zones list contract', () => {
  it('proxies a typed envelope through makePolaris unmodified', async () => {
    const mockBody: CfZoneListResponse = {
      data: [
        fakeZone('all-good.example'),
        fakeZone('partial.example', {
          sender_onboarded: false,
          sender_missing_records: ['_dmarc TXT v=DMARC1; p=none'],
          overall: 'partial',
        }),
        fakeZone('error.example', {
          routing_enabled: false,
          routing_status: 'unconfigured',
          routing_status_ok: false,
          dns_records_locked: false,
          sender_onboarded: false,
          catch_all_target: null,
          catch_all_correct: false,
          d1_mail_domain_exists: false,
          overall: 'error',
          error: 'CF API 401',
        }),
      ],
      fetched_at: new Date('2026-01-01T00:00:00Z').toISOString(),
      cached: false,
    };
    const stubFetcher = {
      fetch: async () => new Response(JSON.stringify(mockBody), { status: 200 }),
    } as unknown as Fetcher;
    const env: Env = {
      DB: {} as D1Database,
      API: stubFetcher,
      ASSETS: stubFetcher,
      OIDC_ADMIN_GROUP: 'polaris-admins',
      COOKIE_PATH: '/panel',
    };
    const polaris = makePolaris(env);
    const r = await polaris.call<CfZoneListResponse>('GET', '/v1/admin/cf-zones');
    expect(r.status).toBe(200);
    expect(r.body.cached).toBe(false);
    expect(r.body.data).toHaveLength(3);
    // Page renders the six status badges from these flags — verify the
    // shape we've documented in the panel types matches the wire envelope.
    const ok = r.body.data[0]!;
    expect(ok.overall).toBe('ok');
    expect(ok.routing_enabled).toBe(true);
    expect(ok.dns_records_locked).toBe(true);
    expect(ok.sender_onboarded).toBe(true);
    expect(ok.catch_all_correct).toBe(true);
    expect(ok.has_conflicting_rules).toBe(false);
    expect(ok.d1_mail_domain_exists).toBe(true);

    const partial = r.body.data[1]!;
    expect(partial.overall).toBe('partial');
    expect(partial.sender_missing_records).toContain('_dmarc TXT v=DMARC1; p=none');

    const errored = r.body.data[2]!;
    expect(errored.overall).toBe('error');
    expect(errored.error).toBe('CF API 401');
    expect(errored.catch_all_target).toBeNull();
  });
});
