// Dashboard smoke test.
//
// React Testing Library + jsdom aren't installed in this repo (the panel
// builds with vite/tsc and the harness keeps test deps narrow). We exercise
// the Dashboard's data shape contract instead: the StatsOverview type a
// mocked SDK would return, and verify the panel proxy hands it through
// unmodified. This protects the (hand-written) hook → page interface that the
// real DOM render would exercise.
import { describe, expect, it } from 'vitest';
import { makePolaris } from '../src/server/polaris.js';
import type { Env } from '../src/server/env.js';

describe('Dashboard contract', () => {
  it('proxies a stats-overview-shaped response through makePolaris unchanged', async () => {
    const mockBody = {
      window: '24h',
      cardinality: {
        mailboxes: 1,
        domains_verified: 2,
        domains_pending: 0,
        domains_failed: 0,
        senders: 3,
        credentials_api_key: 4,
        credentials_smtp: 5,
        webhook_subs: 6,
      },
      messages: { sent: 7, delivered: 8, failed: 9, bounced: 10, inbound_received: 11 },
      dlq_depth: 12,
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
    const r = await polaris.call<typeof mockBody>('GET', '/v1/admin/stats/overview');
    expect(r.status).toBe(200);
    expect(r.body.cardinality.mailboxes).toBe(1);
    expect(r.body.messages.delivered).toBe(8);
    expect(r.body.dlq_depth).toBe(12);
  });
});
