import { describe, expect, it } from 'vitest';
import { drainMoxOpsOnce } from '../src/mox-ops.js';
import type { MoxClient } from '../src/mox-client.js';
import type { PolarisClient } from '../src/polaris-client.js';

interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

function mockPolaris(opsResponse: { ops: unknown[] }): {
  polaris: PolarisClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const polaris: PolarisClient = {
    async request<T = unknown>(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });
      if (method === 'GET' && path === '/v1/bridge/mox-ops') {
        return { status: 200, body: opsResponse as unknown as T };
      }
      if (method === 'POST' && path.startsWith('/v1/bridge/mox-ops/')) {
        return { status: 200, body: { id: 'x', status: 'acked' } as unknown as T };
      }
      return { status: 404, body: {} as T };
    },
  };
  return { polaris, calls };
}

interface MoxCallRecord {
  fn: string;
  account: string;
  plaintext?: string;
}

function mockMox(overrides: Partial<MoxClient> = {}): { mox: MoxClient; calls: MoxCallRecord[] } {
  const calls: MoxCallRecord[] = [];
  const mox: MoxClient = {
    async messageImport() {
      throw new Error('unused');
    },
    async reloadConfig() {
      /* noop */
    },
    async ensureAccount() {
      return true;
    },
    async setAccountPassword(account, plaintext) {
      calls.push({ fn: 'setAccountPassword', account, plaintext });
      return true;
    },
    async removeAccount(account) {
      calls.push({ fn: 'removeAccount', account });
      return true;
    },
    async listAccounts() {
      return [];
    },
    parseOutgoingWebhook() {
      return { account: '', rfc822: Buffer.alloc(0), from: '', to: [] };
    },
    ...overrides,
  };
  return { mox, calls };
}

describe('drainMoxOpsOnce', () => {
  it('decodes payload_b64 and calls setAccountPassword, then acks ok:true', async () => {
    const plaintext = 'TOPSECRET-PW-123';
    const payload_b64 = Buffer.from(plaintext, 'utf8').toString('base64');
    const { polaris, calls: polarisCalls } = mockPolaris({
      ops: [
        {
          id: '01HSP000000000000000000001',
          op: 'set_password',
          username: 'noreply@plrs.im',
          payload_b64,
          attempts: 0,
        },
      ],
    });
    const { mox, calls: moxCalls } = mockMox();
    const result = await drainMoxOpsOnce({ polaris, mox });
    expect(result).toEqual({ processed: 1, acked: 1, failed: 0 });
    expect(moxCalls).toHaveLength(1);
    expect(moxCalls[0]).toMatchObject({
      fn: 'setAccountPassword',
      account: 'noreply@plrs.im',
      plaintext,
    });
    // Find the ack POST
    const ack = polarisCalls.find(
      (c) => c.method === 'POST' && c.path === '/v1/bridge/mox-ops/01HSP000000000000000000001/ack',
    );
    expect(ack).toBeTruthy();
    expect(ack?.body).toEqual({ ok: true });
  });

  it('acks ok:false with error when Mox throws', async () => {
    const payload_b64 = Buffer.from('pw', 'utf8').toString('base64');
    const { polaris, calls: polarisCalls } = mockPolaris({
      ops: [
        {
          id: '01HSP000000000000000000002',
          op: 'set_password',
          username: 'broken@plrs.im',
          payload_b64,
          attempts: 0,
        },
      ],
    });
    const { mox } = mockMox({
      async setAccountPassword() {
        throw new Error('mox down');
      },
    });
    const result = await drainMoxOpsOnce({ polaris, mox });
    expect(result.failed).toBe(1);
    const ack = polarisCalls.find(
      (c) => c.method === 'POST' && c.path.endsWith('/ack'),
    );
    expect(ack?.body).toMatchObject({ ok: false, error: 'mox down' });
  });

  it('handles remove_account ops', async () => {
    const { polaris, calls: polarisCalls } = mockPolaris({
      ops: [
        {
          id: '01HSP000000000000000000003',
          op: 'remove_account',
          username: 'gone@plrs.im',
          payload_b64: null,
          attempts: 0,
        },
      ],
    });
    const { mox, calls: moxCalls } = mockMox();
    const result = await drainMoxOpsOnce({ polaris, mox });
    expect(result.acked).toBe(1);
    expect(moxCalls[0]).toMatchObject({ fn: 'removeAccount', account: 'gone@plrs.im' });
    const ack = polarisCalls.find((c) => c.method === 'POST');
    expect(ack?.body).toEqual({ ok: true });
  });

  it('returns zero when the api Worker responds with non-200', async () => {
    const polaris: PolarisClient = {
      async request() {
        return { status: 500, body: {} };
      },
    };
    const { mox, calls: moxCalls } = mockMox();
    const result = await drainMoxOpsOnce({ polaris, mox });
    expect(result).toEqual({ processed: 0, acked: 0, failed: 0 });
    expect(moxCalls).toHaveLength(0);
  });
});
