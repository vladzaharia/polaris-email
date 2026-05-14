// Mailboxes-list smoke test.
//
// Same constraint as `dashboard.test.ts`: no DOM environment available. We
// assert the empty-state shape the page reads — an envelope `{ data: [] }` —
// flows through the panel proxy unmodified, so the list page's "no mailboxes
// yet" branch is reachable end-to-end.
import { describe, expect, it } from 'vitest';
import { makePolaris } from '../src/server/polaris.js';
import type { Env } from '../src/server/env.js';

describe('Mailboxes list contract', () => {
  it('returns an empty envelope from the upstream list endpoint', async () => {
    const stubFetcher = {
      fetch: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    } as unknown as Fetcher;
    const env: Env = {
      DB: {} as D1Database,
      API: stubFetcher,
      ASSETS: stubFetcher,
      ADMIN_GROUP: 'polaris-admins',
      COOKIE_PATH: '/panel',
    };
    const polaris = makePolaris(env);
    const r = await polaris.call<{ data: unknown[] }>('GET', '/v1/admin/mailboxes');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.data)).toBe(true);
    expect(r.body.data).toHaveLength(0);
  });
});
