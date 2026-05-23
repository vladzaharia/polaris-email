import { describe, expect, it, vi } from 'vitest';
import { CloudflareApiClient } from '../src/client.js';
import { graphqlQuery } from '../src/graphql.js';

function clientWithFetch(fetchImpl: typeof fetch): CloudflareApiClient {
  return new CloudflareApiClient({
    apiToken: 'tkn',
    accountId: 'acct',
    fetchImpl,
  });
}

describe('graphqlQuery', () => {
  it('POSTs to /client/v4/graphql with bearer auth and a JSON body', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://api.cloudflare.com/client/v4/graphql');
      expect(init?.method).toBe('POST');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer tkn');
      expect(headers.get('content-type')).toBe('application/json');
      const body = JSON.parse(init?.body as string);
      expect(body.query).toContain('viewer');
      expect(body.variables).toEqual({ z: 'zone1' });
      return new Response(JSON.stringify({ data: { viewer: { zones: [] } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = clientWithFetch(fetchMock as unknown as typeof fetch);
    const r = await graphqlQuery<{ viewer: { zones: unknown[] } }>(client, {
      query: 'query($z: String!){ viewer { zones(filter: {zoneTag: $z}) { __typename } } }',
      variables: { z: 'zone1' },
    });
    expect(r.viewer.zones).toEqual([]);
  });

  it('throws on a GraphQL errors[] response', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ errors: [{ message: 'bad zone' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const client = clientWithFetch(fetchMock as unknown as typeof fetch);
    await expect(graphqlQuery(client, { query: '{ foo }', variables: {} })).rejects.toThrow(
      /bad zone/,
    );
  });

  it('throws on a non-2xx response', async () => {
    const fetchMock = vi.fn(async () => new Response('Unauthorized', { status: 401 }));
    const client = clientWithFetch(fetchMock as unknown as typeof fetch);
    await expect(graphqlQuery(client, { query: '{ foo }', variables: {} })).rejects.toThrow(
      /cf graphql 401/,
    );
  });
});
