// Phase 4a.10 — exponential backoff with Retry-After honouring on
// 429/503 responses, capped at maxRetries.
import { describe, it, expect } from 'vitest';
import { CloudflareApiClient, CloudflareApiError } from '../src/client.js';

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify({ success: true, result: body }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function jsonErr(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

describe('CloudflareApiClient retries', () => {
  it('retries a 429 then succeeds, honouring Retry-After', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const client = new CloudflareApiClient({
      apiToken: 't',
      accountId: 'acc',
      fetchImpl: (async () => {
        calls++;
        if (calls === 1) {
          return jsonErr(429, '{"success":false,"errors":[]}', { 'retry-after': '0' });
        }
        return jsonOk({ ok: true });
      }) as unknown as typeof fetch,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    });
    const r = await client.get<{ ok: boolean }>('/zones/abc');
    expect(r.ok).toBe(true);
    expect(calls).toBe(2);
    // Retry-After: 0s -> sleep 0ms.
    expect(sleeps).toEqual([0]);
  });

  it('retries a 503 then succeeds, with exponential backoff when no Retry-After', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const client = new CloudflareApiClient({
      apiToken: 't',
      accountId: 'acc',
      fetchImpl: (async () => {
        calls++;
        if (calls < 3) return jsonErr(503, '');
        return jsonOk({ ok: true });
      }) as unknown as typeof fetch,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    });
    await client.get('/zones/abc');
    expect(calls).toBe(3);
    // Exponential backoff: 1000, 2000.
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('caps at maxRetries (default 3) and surfaces the final error', async () => {
    let calls = 0;
    const client = new CloudflareApiClient({
      apiToken: 't',
      accountId: 'acc',
      fetchImpl: (async () => {
        calls++;
        return jsonErr(429, '{"success":false,"errors":[]}', { 'retry-after': '0' });
      }) as unknown as typeof fetch,
      sleepImpl: async () => undefined,
    });
    await expect(client.get('/zones/abc')).rejects.toBeInstanceOf(CloudflareApiError);
    // Initial + 3 retries = 4 attempts.
    expect(calls).toBe(4);
  });

  it('does NOT retry on 4xx other than 429', async () => {
    let calls = 0;
    const client = new CloudflareApiClient({
      apiToken: 't',
      accountId: 'acc',
      fetchImpl: (async () => {
        calls++;
        return jsonErr(404, '{"success":false,"errors":[{"code":7003,"message":"not found"}]}');
      }) as unknown as typeof fetch,
      sleepImpl: async () => undefined,
    });
    await expect(client.get('/zones/abc')).rejects.toBeInstanceOf(CloudflareApiError);
    expect(calls).toBe(1);
  });

  it('honours maxRetries=0 (no retries)', async () => {
    let calls = 0;
    const client = new CloudflareApiClient({
      apiToken: 't',
      accountId: 'acc',
      maxRetries: 0,
      fetchImpl: (async () => {
        calls++;
        return jsonErr(429, '{"success":false,"errors":[]}');
      }) as unknown as typeof fetch,
      sleepImpl: async () => undefined,
    });
    await expect(client.get('/zones/abc')).rejects.toBeInstanceOf(CloudflareApiError);
    expect(calls).toBe(1);
  });
});
