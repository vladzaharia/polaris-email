import { describe, it, expect } from 'vitest';
import { CloudflareApiClient } from '../src/client.js';
import {
  expectedMtaStsRecords,
  expectedTlsRptRecord,
  generatePolicyId,
  provisionMtaSts,
  unprovisionMtaSts,
  provisionTlsRpt,
  unprovisionTlsRpt,
} from '../src/mta-sts.js';

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
    const call: RecordedCall = { method, url, body };
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

function ok(result: unknown): Response {
  return new Response(JSON.stringify({ success: true, errors: [], messages: [], result }));
}

describe('generatePolicyId', () => {
  it('returns a deterministic timestamp ID for a fixed date', () => {
    const id = generatePolicyId(new Date('2026-05-15T12:00:00Z'));
    expect(id).toBe('20260515T120000Z');
  });

  it('produces a 16-char alphanumeric ID conforming to RFC 8461 §3.1', () => {
    const id = generatePolicyId();
    // RFC 8461 allows 1*32(ALPHA / DIGIT); we use a 16-char compressed ISO ts.
    expect(id).toMatch(/^[0-9A-Z]+$/);
    expect(id.length).toBe(16);
  });
});

describe('expectedMtaStsRecords', () => {
  it('returns exactly one TXT record at _mta-sts.{domain} with v=STSv1; id=<policyId>', () => {
    const recs = expectedMtaStsRecords({ domain: 'acme.com', policyId: '20260515T120000Z' });
    expect(recs).toHaveLength(1);
    expect(recs[0].type).toBe('TXT');
    expect(recs[0].name).toBe('_mta-sts.acme.com');
    expect(recs[0].content).toBe('v=STSv1; id=20260515T120000Z');
  });

  it('does NOT include a CNAME for mta-sts.{domain} (that is a Worker custom domain)', () => {
    const recs = expectedMtaStsRecords({ domain: 'acme.com', policyId: 'X' });
    expect(recs.find((r) => r.type === 'CNAME')).toBeUndefined();
    expect(recs.find((r) => r.name === 'mta-sts.acme.com')).toBeUndefined();
  });
});

describe('expectedTlsRptRecord', () => {
  it('returns a TXT record at _smtp._tls.{domain} with v=TLSRPTv1; rua=<uri>', () => {
    const rec = expectedTlsRptRecord({
      domain: 'acme.com',
      rua: 'mailto:tlsrpt@acme.com',
    });
    expect(rec.type).toBe('TXT');
    expect(rec.name).toBe('_smtp._tls.acme.com');
    expect(rec.content).toBe('v=TLSRPTv1; rua=mailto:tlsrpt@acme.com');
  });

  it('passes the rua URI through verbatim (HTTPS or comma-separated)', () => {
    const rec = expectedTlsRptRecord({
      domain: 'acme.com',
      rua: 'https://tlsrpt.example.com/r,mailto:tlsrpt@acme.com',
    });
    expect(rec.content).toBe('v=TLSRPTv1; rua=https://tlsrpt.example.com/r,mailto:tlsrpt@acme.com');
  });
});

describe('provisionMtaSts', () => {
  it('create-fresh path: creates TXT and attaches worker custom domain', async () => {
    const { client, calls } = makeClient((call) => {
      if (call.method === 'GET' && call.url.includes('/dns_records')) {
        return ok([]); // no existing DNS records
      }
      if (call.method === 'POST' && call.url.includes('/dns_records')) {
        return ok({
          id: 'rec-1',
          type: 'TXT',
          name: '_mta-sts.acme.com',
          content: 'v=STSv1; id=20260515T120000Z',
        });
      }
      if (call.method === 'GET' && call.url.includes('/workers/domains')) {
        return ok([]); // no existing custom domain
      }
      if (call.method === 'PUT' && call.url.includes('/workers/domains')) {
        return ok({
          id: 'dom-1',
          hostname: 'mta-sts.acme.com',
          zone_id: 'zone-1',
          service: 'polaris-email-api',
        });
      }
      throw new Error(`unexpected ${call.method} ${call.url}`);
    });

    const result = await provisionMtaSts(client, {
      zoneId: 'zone-1',
      domain: 'acme.com',
      policyId: '20260515T120000Z',
      workerName: 'polaris-email-api',
    });

    expect(result.created).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.customDomainAttached).toBe(true);

    const posts = calls.filter((c) => c.method === 'POST' && c.url.includes('/dns_records'));
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({
      type: 'TXT',
      name: '_mta-sts.acme.com',
      content: 'v=STSv1; id=20260515T120000Z',
    });

    const puts = calls.filter((c) => c.method === 'PUT' && c.url.includes('/workers/domains'));
    expect(puts).toHaveLength(1);
    expect(puts[0].body).toMatchObject({
      hostname: 'mta-sts.acme.com',
      service: 'polaris-email-api',
      zone_id: 'zone-1',
    });
  });

  it('skip path: when TXT already matches, does not POST', async () => {
    const { client, calls } = makeClient((call) => {
      if (call.method === 'GET' && call.url.includes('/dns_records')) {
        return ok([
          {
            id: 'rec-1',
            type: 'TXT',
            name: '_mta-sts.acme.com',
            content: 'v=STSv1; id=20260515T120000Z',
          },
        ]);
      }
      if (call.method === 'GET' && call.url.includes('/workers/domains')) {
        return ok([
          {
            id: 'dom-1',
            hostname: 'mta-sts.acme.com',
            zone_id: 'zone-1',
            service: 'polaris-email-api',
          },
        ]);
      }
      throw new Error(`unexpected ${call.method} ${call.url}`);
    });

    const result = await provisionMtaSts(client, {
      zoneId: 'zone-1',
      domain: 'acme.com',
      policyId: '20260515T120000Z',
      workerName: 'polaris-email-api',
    });

    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.customDomainAttached).toBe(true);

    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  });

  it('update path: when TXT content differs, replaces it (delete + create or PATCH)', async () => {
    const { client, calls } = makeClient((call) => {
      if (call.method === 'GET' && call.url.includes('/dns_records')) {
        return ok([
          {
            id: 'rec-1',
            type: 'TXT',
            name: '_mta-sts.acme.com',
            content: 'v=STSv1; id=OLD',
          },
        ]);
      }
      if (call.method === 'GET' && call.url.includes('/workers/domains')) {
        return ok([]);
      }
      if (call.method === 'POST' && call.url.includes('/dns_records')) {
        return ok({
          id: 'rec-2',
          type: 'TXT',
          name: '_mta-sts.acme.com',
          content: 'v=STSv1; id=NEW',
        });
      }
      if (call.method === 'PATCH' && call.url.includes('/dns_records/rec-1')) {
        return ok({
          id: 'rec-1',
          type: 'TXT',
          name: '_mta-sts.acme.com',
          content: 'v=STSv1; id=NEW',
        });
      }
      if (call.method === 'PUT' && call.url.includes('/workers/domains')) {
        return ok({
          id: 'dom-1',
          hostname: 'mta-sts.acme.com',
          zone_id: 'zone-1',
          service: 'polaris-email-api',
        });
      }
      throw new Error(`unexpected ${call.method} ${call.url}`);
    });

    const result = await provisionMtaSts(client, {
      zoneId: 'zone-1',
      domain: 'acme.com',
      policyId: 'NEW',
      workerName: 'polaris-email-api',
    });

    // Tracked as created (the record was effectively replaced).
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(0);

    // Accept either PATCH or POST as the update strategy.
    const mutations = calls.filter(
      (c) =>
        (c.method === 'PATCH' && c.url.includes('/dns_records/rec-1')) ||
        (c.method === 'POST' && c.url.includes('/dns_records')),
    );
    expect(mutations.length).toBeGreaterThanOrEqual(1);
  });
});

describe('unprovisionMtaSts', () => {
  it('deletes TXT records and detaches the worker custom domain', async () => {
    const { client, calls } = makeClient((call) => {
      if (call.method === 'GET' && call.url.includes('/dns_records')) {
        return ok([
          {
            id: 'rec-1',
            type: 'TXT',
            name: '_mta-sts.acme.com',
            content: 'v=STSv1; id=X',
          },
        ]);
      }
      if (call.method === 'GET' && call.url.includes('/workers/domains')) {
        return ok([
          {
            id: 'dom-1',
            hostname: 'mta-sts.acme.com',
            zone_id: 'zone-1',
            service: 'polaris-email-api',
          },
        ]);
      }
      if (call.method === 'DELETE') return ok({ id: 'gone' });
      throw new Error(`unexpected ${call.method} ${call.url}`);
    });

    await unprovisionMtaSts(client, { zoneId: 'zone-1', domain: 'acme.com' });
    const deletes = calls.filter((c) => c.method === 'DELETE');
    expect(deletes.length).toBeGreaterThanOrEqual(2); // dns_records + workers/domains
    expect(deletes.some((c) => c.url.includes('/dns_records/rec-1'))).toBe(true);
    expect(deletes.some((c) => c.url.includes('/workers/domains/dom-1'))).toBe(true);
  });

  it('no-ops when nothing is published', async () => {
    const { client, calls } = makeClient((call) => {
      if (call.method === 'GET') return ok([]);
      throw new Error(`unexpected ${call.method} ${call.url}`);
    });

    await unprovisionMtaSts(client, { zoneId: 'zone-1', domain: 'acme.com' });
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });
});

describe('provisionTlsRpt', () => {
  it('creates TXT at _smtp._tls.{domain} when none exists', async () => {
    const { client, calls } = makeClient((call) => {
      if (call.method === 'GET') return ok([]);
      if (call.method === 'POST') {
        return ok({
          id: 'rec-tls',
          type: 'TXT',
          name: '_smtp._tls.acme.com',
          content: 'v=TLSRPTv1; rua=mailto:tlsrpt@acme.com',
        });
      }
      throw new Error(`unexpected ${call.method}`);
    });

    const result = await provisionTlsRpt(client, {
      zoneId: 'zone-1',
      domain: 'acme.com',
      rua: 'mailto:tlsrpt@acme.com',
    });
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.customDomainAttached).toBe(false);

    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('skips when TXT already matches', async () => {
    const { client, calls } = makeClient((call) => {
      if (call.method === 'GET') {
        return ok([
          {
            id: 'rec-tls',
            type: 'TXT',
            name: '_smtp._tls.acme.com',
            content: 'v=TLSRPTv1; rua=mailto:tlsrpt@acme.com',
          },
        ]);
      }
      throw new Error(`unexpected ${call.method}`);
    });

    const result = await provisionTlsRpt(client, {
      zoneId: 'zone-1',
      domain: 'acme.com',
      rua: 'mailto:tlsrpt@acme.com',
    });
    expect(result.skipped).toBe(1);
    expect(result.created).toBe(0);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});

describe('unprovisionTlsRpt', () => {
  it('deletes the TXT record when present', async () => {
    const { client, calls } = makeClient((call) => {
      if (call.method === 'GET') {
        return ok([
          {
            id: 'rec-tls',
            type: 'TXT',
            name: '_smtp._tls.acme.com',
            content: 'v=TLSRPTv1; rua=mailto:tlsrpt@acme.com',
          },
        ]);
      }
      if (call.method === 'DELETE') return ok({ id: 'gone' });
      throw new Error(`unexpected ${call.method}`);
    });

    await unprovisionTlsRpt(client, { zoneId: 'zone-1', domain: 'acme.com' });
    const dels = calls.filter((c) => c.method === 'DELETE');
    expect(dels).toHaveLength(1);
    expect(dels[0].url).toContain('/dns_records/rec-tls');
  });

  it('no-ops when nothing is published', async () => {
    const { client, calls } = makeClient((call) => {
      if (call.method === 'GET') return ok([]);
      throw new Error(`unexpected ${call.method}`);
    });
    await unprovisionTlsRpt(client, { zoneId: 'zone-1', domain: 'acme.com' });
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });
});
