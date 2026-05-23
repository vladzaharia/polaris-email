import { describe, expect, it, vi } from 'vitest';
import { CloudflareApiClient } from '../src/client.js';
import { fetchDmarcAggregatesByDay } from '../src/dmarc-graphql.js';

describe('fetchDmarcAggregatesByDay', () => {
  it('queries dmarcReportsAdaptive by day for the given zone + date window', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      expect(body.query).toContain('dmarcReportsAdaptive');
      expect(body.variables).toEqual({
        zoneTag: 'cfz_x',
        since: '2026-05-21T00:00:00Z',
        until: '2026-05-23T23:59:59Z',
      });
      return new Response(
        JSON.stringify({
          data: {
            viewer: {
              zones: [
                {
                  dmarcReportsAdaptive: [
                    {
                      dimensions: { date: '2026-05-22', headerFrom: 'good.example' },
                      sum: {
                        totalCount: 100,
                        dmarcPassedCount: 99,
                        dkimPassedCount: 99,
                        spfPassedCount: 98,
                      },
                    },
                  ],
                },
              ],
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const client = new CloudflareApiClient({
      apiToken: 'tkn',
      accountId: 'acct',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const rows = await fetchDmarcAggregatesByDay(client, {
      zoneTag: 'cfz_x',
      since: '2026-05-21T00:00:00Z',
      until: '2026-05-23T23:59:59Z',
    });
    expect(rows).toEqual([
      {
        day: '2026-05-22',
        domain: 'good.example',
        totalCount: 100,
        dmarcPass: 99,
        dkimPass: 99,
        spfPass: 98,
      },
    ]);
  });

  it('returns [] when no zone matches', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { viewer: { zones: [] } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const client = new CloudflareApiClient({
      apiToken: 'tkn',
      accountId: 'acct',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const rows = await fetchDmarcAggregatesByDay(client, {
      zoneTag: 'missing',
      since: '2026-05-21T00:00:00Z',
      until: '2026-05-23T23:59:59Z',
    });
    expect(rows).toEqual([]);
  });
});
