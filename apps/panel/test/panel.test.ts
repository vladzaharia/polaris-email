import { describe, expect, it } from 'vitest';
import { makePolaris } from '../src/server/polaris.js';
import type { Env } from '../src/server/env.js';

describe('makePolaris', () => {
  it('returns a client bound to the API service binding', () => {
    // Minimal stub Env. The service binding's fetch is never called here;
    // we just confirm the SDK wrapper is wired correctly.
    const stubFetcher = { fetch: async () => new Response('{}') } as unknown as Fetcher;
    const env: Env = {
      DB: {} as D1Database,
      API: stubFetcher,
      ASSETS: stubFetcher,
      ADMIN_GROUP: 'polaris-admins',
      COOKIE_PATH: '/panel',
    };
    const c = makePolaris(env);
    expect(typeof c.call).toBe('function');
  });
});
