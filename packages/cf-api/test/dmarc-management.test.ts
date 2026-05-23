import { describe, expect, it, vi } from 'vitest';
import { CloudflareApiClient } from '../src/client.js';
import {
  enableDmarcManagement,
  getDmarcManagementStatus,
  setDmarcPolicy,
} from '../src/dmarc-management.js';

function clientWithFetch(fetchImpl: typeof fetch): CloudflareApiClient {
  return new CloudflareApiClient({
    apiToken: 'tkn',
    accountId: 'acct',
    fetchImpl,
    maxRetries: 0,
  });
}

describe('enableDmarcManagement', () => {
  it('POSTs to /zones/{zone}/dmarc_management', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain('/zones/zone_x/dmarc_management');
      expect(init?.method).toBe('POST');
      return new Response(JSON.stringify({ success: true, result: { enabled: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const r = await enableDmarcManagement(
      clientWithFetch(fetchMock as unknown as typeof fetch),
      'zone_x',
    );
    expect(r.enabled).toBe(true);
  });

  it('treats a 409 as already-enabled', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 1001, message: 'already enabled' }],
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
    );
    const r = await enableDmarcManagement(
      clientWithFetch(fetchMock as unknown as typeof fetch),
      'zone_x',
    );
    expect(r.enabled).toBe(true);
  });

  it('treats an "already enabled" error message as success', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 4001, message: 'DMARC Management is already enabled for this zone' }],
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
    );
    const r = await enableDmarcManagement(
      clientWithFetch(fetchMock as unknown as typeof fetch),
      'zone_x',
    );
    expect(r.enabled).toBe(true);
  });

  it('rethrows other errors', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ success: false, errors: [{ code: 6003, message: 'invalid token' }] }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
    );
    await expect(
      enableDmarcManagement(clientWithFetch(fetchMock as unknown as typeof fetch), 'zone_x'),
    ).rejects.toThrow(/invalid token/);
  });
});

describe('setDmarcPolicy', () => {
  it('PATCHes the zone DMARC Management policy', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain('/zones/zone_x/dmarc_management');
      expect(init?.method).toBe('PATCH');
      const body = JSON.parse(init?.body as string);
      expect(body.policy).toBe('quarantine');
      return new Response(JSON.stringify({ success: true, result: { policy: 'quarantine' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const r = await setDmarcPolicy(
      clientWithFetch(fetchMock as unknown as typeof fetch),
      'zone_x',
      'quarantine',
    );
    expect(r.policy).toBe('quarantine');
  });
});

describe('getDmarcManagementStatus', () => {
  it('returns null when the endpoint 404s', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ success: false, errors: [{ code: 7003, message: 'not found' }] }),
          {
            status: 404,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );
    const r = await getDmarcManagementStatus(
      clientWithFetch(fetchMock as unknown as typeof fetch),
      'zone_x',
    );
    expect(r).toBeNull();
  });

  it('returns the enabled + policy fields on 200', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true, result: { enabled: true, policy: 'none' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const r = await getDmarcManagementStatus(
      clientWithFetch(fetchMock as unknown as typeof fetch),
      'zone_x',
    );
    expect(r).toEqual({ enabled: true, policy: 'none' });
  });
});
