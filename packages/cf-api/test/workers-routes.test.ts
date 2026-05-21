import { describe, it, expect } from 'vitest';
import { CloudflareApiClient } from '../src/client.js';
import { attachCustomDomain, findCustomDomain, detachCustomDomain } from '../src/workers-routes.js';

interface RecordedCall {
  method: string;
  url: string;
  body?: unknown;
}

function makeClient(handler: (call: RecordedCall) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const method = init?.method ?? 'GET';
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call = { method, url, body };
    calls.push(call);
    return handler(call);
  };
  const client = new CloudflareApiClient({
    apiToken: 't',
    accountId: 'acc-1',
    fetchImpl: fetchImpl as typeof fetch,
  });
  return { client, calls };
}

function okEnvelope(result: unknown): Response {
  return new Response(JSON.stringify({ success: true, errors: [], messages: [], result }));
}

describe('findCustomDomain', () => {
  it('returns the matching domain when the list call yields exactly one match', async () => {
    const { client, calls } = makeClient((call) => {
      if (call.method === 'GET' && call.url.includes('/workers/domains')) {
        return okEnvelope([
          {
            id: 'dom-1',
            hostname: 'mta-sts.acme.com',
            zone_id: 'zone-1',
            service: 'polaris-mail-api',
            environment: 'production',
          },
        ]);
      }
      throw new Error(`unexpected call ${call.method} ${call.url}`);
    });

    const found = await findCustomDomain(client, 'mta-sts.acme.com');
    expect(found).toEqual({
      id: 'dom-1',
      hostname: 'mta-sts.acme.com',
      zoneId: 'zone-1',
      service: 'polaris-mail-api',
      environment: 'production',
    });
    expect(calls[0].url).toContain('/accounts/acc-1/workers/domains');
    expect(calls[0].url).toContain('hostname=mta-sts.acme.com');
  });

  it('returns null when the list call returns empty', async () => {
    const { client } = makeClient(() => okEnvelope([]));
    const found = await findCustomDomain(client, 'absent.acme.com');
    expect(found).toBeNull();
  });
});

describe('attachCustomDomain', () => {
  it('PUTs the worker domain with hostname/service/zone_id and returns the result', async () => {
    const { client, calls } = makeClient((call) => {
      if (call.method === 'GET') return okEnvelope([]); // no existing
      if (call.method === 'PUT') {
        return okEnvelope({
          id: 'dom-99',
          hostname: 'mta-sts.acme.com',
          zone_id: 'zone-1',
          service: 'polaris-mail-api',
          environment: 'production',
        });
      }
      throw new Error(`unexpected ${call.method}`);
    });

    const dom = await attachCustomDomain(client, {
      zoneId: 'zone-1',
      hostname: 'mta-sts.acme.com',
      workerName: 'polaris-mail-api',
    });

    expect(dom.id).toBe('dom-99');
    expect(dom.hostname).toBe('mta-sts.acme.com');
    expect(dom.zoneId).toBe('zone-1');
    expect(dom.service).toBe('polaris-mail-api');

    const put = calls.find((c) => c.method === 'PUT');
    expect(put).toBeDefined();
    expect(put!.url).toContain('/accounts/acc-1/workers/domains');
    expect(put!.body).toEqual({
      hostname: 'mta-sts.acme.com',
      service: 'polaris-mail-api',
      zone_id: 'zone-1',
    });
  });

  it('is idempotent — when find returns a matching domain (same worker + zone), skips PUT', async () => {
    const { client, calls } = makeClient((call) => {
      if (call.method === 'GET') {
        return okEnvelope([
          {
            id: 'dom-existing',
            hostname: 'mta-sts.acme.com',
            zone_id: 'zone-1',
            service: 'polaris-mail-api',
          },
        ]);
      }
      throw new Error(`should not have called ${call.method}`);
    });

    const dom = await attachCustomDomain(client, {
      zoneId: 'zone-1',
      hostname: 'mta-sts.acme.com',
      workerName: 'polaris-mail-api',
    });

    expect(dom.id).toBe('dom-existing');
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(0);
  });

  it('includes environment when provided', async () => {
    const { client, calls } = makeClient((call) => {
      if (call.method === 'GET') return okEnvelope([]);
      return okEnvelope({
        id: 'dom-2',
        hostname: 'mta-sts.acme.com',
        zone_id: 'zone-1',
        service: 'polaris-mail-api',
        environment: 'staging',
      });
    });

    await attachCustomDomain(client, {
      zoneId: 'zone-1',
      hostname: 'mta-sts.acme.com',
      workerName: 'polaris-mail-api',
      environment: 'staging',
    });

    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body).toEqual({
      hostname: 'mta-sts.acme.com',
      service: 'polaris-mail-api',
      zone_id: 'zone-1',
      environment: 'staging',
    });
  });
});

describe('detachCustomDomain', () => {
  it('finds the domain by hostname then DELETEs by id', async () => {
    const { client, calls } = makeClient((call) => {
      if (call.method === 'GET') {
        return okEnvelope([
          {
            id: 'dom-7',
            hostname: 'mta-sts.acme.com',
            zone_id: 'zone-1',
            service: 'polaris-mail-api',
          },
        ]);
      }
      if (call.method === 'DELETE') return okEnvelope({ id: 'dom-7' });
      throw new Error(`unexpected ${call.method}`);
    });

    await detachCustomDomain(client, 'mta-sts.acme.com');
    const del = calls.find((c) => c.method === 'DELETE');
    expect(del).toBeDefined();
    expect(del!.url).toContain('/accounts/acc-1/workers/domains/dom-7');
  });

  it('no-ops when no matching domain exists', async () => {
    const { client, calls } = makeClient((call) => {
      if (call.method === 'GET') return okEnvelope([]);
      throw new Error(`should not call ${call.method}`);
    });

    await detachCustomDomain(client, 'absent.acme.com');
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });
});
