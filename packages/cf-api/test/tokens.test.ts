// Unit tests for tokens.ts — per-bridge CF API token mint + revoke.
// Mirrors the workers-routes test pattern: capture every fetch call to
// confirm body shape, then return canned CF envelopes.
import { describe, it, expect } from 'vitest';
import { CloudflareApiClient } from '../src/client.js';
import { mintBridgeDnsToken, revokeToken } from '../src/tokens.js';

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

describe('mintBridgeDnsToken', () => {
  it('POSTs /user/tokens with a single policy scoped to the target zone', async () => {
    const { client, calls } = makeClient((call) => {
      if (call.method === 'POST' && call.url.endsWith('/user/tokens')) {
        return okEnvelope({ id: 'tok-1', value: 'v1.0-secret-plaintext' });
      }
      throw new Error(`unexpected ${call.method} ${call.url}`);
    });

    const minted = await mintBridgeDnsToken(client, {
      name: 'polaris-bridge-acme-01HXBRIDGE',
      zoneId: 'zone-abc',
    });

    expect(minted).toEqual({ id: 'tok-1', value: 'v1.0-secret-plaintext' });
    expect(calls).toHaveLength(1);
    const body = calls[0]!.body as {
      name: string;
      policies: Array<{
        effect: string;
        resources: Record<string, string>;
        permission_groups: Array<{ id: string }>;
      }>;
    };
    expect(body.name).toBe('polaris-bridge-acme-01HXBRIDGE');
    expect(body.policies).toHaveLength(1);
    const p = body.policies[0]!;
    expect(p.effect).toBe('allow');
    // Resource is the canonical CF zone-scoped form.
    expect(p.resources).toEqual({ 'com.cloudflare.api.account.zone.zone-abc': '*' });
    // Both Zone DNS Edit and Zone Read present — Lego's CF provider
    // does a GET /zones lookup at startup, so Zone Read is required.
    const ids = p.permission_groups.map((g) => g.id).sort();
    expect(ids).toEqual(
      ['4755a26eedb94da69e1066d98aa820be', 'c8fed203ed3043cba015a93ad1616f1f'].sort(),
    );
  });

  it('propagates CF errors as CloudflareApiError', async () => {
    const { client } = makeClient(() => {
      return new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 10000, message: 'forbidden' }],
          messages: [],
        }),
        { status: 403 },
      );
    });
    await expect(mintBridgeDnsToken(client, { name: 'p', zoneId: 'z' })).rejects.toThrow(
      /forbidden|CloudflareApiError/,
    );
  });
});

describe('revokeToken', () => {
  it('DELETEs /user/tokens/:id', async () => {
    const { client, calls } = makeClient((call) => {
      if (call.method === 'DELETE' && call.url.endsWith('/user/tokens/tok-xyz')) {
        return okEnvelope({ id: 'tok-xyz' });
      }
      throw new Error(`unexpected ${call.method} ${call.url}`);
    });
    await revokeToken(client, 'tok-xyz');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/user\/tokens\/tok-xyz$/);
    expect(calls[0]!.method).toBe('DELETE');
  });
});
