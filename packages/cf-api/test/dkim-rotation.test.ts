import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  planRotation,
  promotePending,
  retireOldKey,
  RETIRE_FLUSH_WINDOW_DAYS,
  type DkimKey,
  type DkimKeyOps,
} from '../src/dkim-rotation.js';
import { CloudflareApiClient } from '../src/client.js';

class FakeOps implements DkimKeyOps {
  rows = new Map<string, DkimKey>();
  private nextId = 1;
  async insertPending(k: Omit<DkimKey, 'state' | 'id'> & { id?: string }): Promise<DkimKey> {
    const id = k.id ?? `dk-${this.nextId++}`;
    const row: DkimKey = { ...k, id, state: 'pending' };
    this.rows.set(id, row);
    return row;
  }
  async setState(id: string, state: DkimKey['state'], ts: string): Promise<void> {
    const r = this.rows.get(id);
    if (!r) throw new Error('not found');
    r.state = state;
    if (state === 'active') r.activatedAt = ts;
    if (state === 'retiring') r.retiredAt = ts;
  }
  async byDomainAndState(domainId: string, state: DkimKey['state']): Promise<DkimKey | null> {
    for (const r of this.rows.values()) {
      if (r.domainId === domainId && r.state === state) return r;
    }
    return null;
  }
  async getById(id: string): Promise<DkimKey | null> {
    return this.rows.get(id) ?? null;
  }
}

function fakeClient(fetchImpl: typeof fetch): CloudflareApiClient {
  return new CloudflareApiClient({
    apiToken: 't',
    accountId: 'acc',
    fetchImpl,
  });
}

describe('planRotation', () => {
  it('produces a fresh selector + DKIM TXT record', async () => {
    const plan = await planRotation({
      algo: 'ed25519',
      domain: 'acme.com',
      generated: { publicKey: 'abc==', privateKey: 'priv' },
    });
    expect(plan.pendingKey.algo).toBe('ed25519');
    expect(plan.pendingKey.expectedRecord.type).toBe('TXT');
    expect(plan.pendingKey.expectedRecord.name).toMatch(/^s\d{4}-1\._domainkey\.acme\.com$/);
    expect(plan.pendingKey.expectedRecord.content).toContain('v=DKIM1; k=ed25519; p=abc==');
  });

  it('increments the sequence when current selector is sYYYY-N', async () => {
    const plan = await planRotation({
      algo: 'rsa2048',
      domain: 'acme.com',
      current: { selector: 's2026-3' } as DkimKey,
      generated: { publicKey: 'p', privateKey: 'k' },
    });
    expect(plan.pendingKey.expectedRecord.name).toContain('s2026-4._domainkey');
  });
});

describe('promotePending', () => {
  it('flips pending → active and prior active → retiring', async () => {
    const ops = new FakeOps();
    const prior = await ops.insertPending({
      domainId: 'd1',
      selector: 's2025-1',
      publicKey: 'old',
      algo: 'rsa2048',
    });
    await ops.setState(prior.id, 'active', '2025-01-01T00:00:00Z');

    const pending = await ops.insertPending({
      domainId: 'd1',
      selector: 's2026-1',
      publicKey: 'new',
      algo: 'ed25519',
    });
    await promotePending(ops, pending.id);

    expect((await ops.getById(pending.id))?.state).toBe('active');
    expect((await ops.getById(prior.id))?.state).toBe('retiring');
  });

  it('refuses to promote a non-pending row', async () => {
    const ops = new FakeOps();
    const k = await ops.insertPending({
      domainId: 'd1',
      selector: 's2026-1',
      publicKey: 'p',
      algo: 'ed25519',
    });
    await ops.setState(k.id, 'active', '2026-01-01');
    await expect(promotePending(ops, k.id)).rejects.toThrow(/expected state=pending/);
  });
});

describe('retireOldKey', () => {
  let ops: FakeOps;
  let client: CloudflareApiClient;
  let calls: { method: string; path: string }[];

  beforeEach(() => {
    ops = new FakeOps();
    calls = [];
    client = fakeClient(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      const method = init?.method ?? 'GET';
      calls.push({ method, path: new URL(url).pathname });
      // Return success envelope; for list calls return one record.
      if (method === 'GET' && url.includes('/dns_records')) {
        return new Response(
          JSON.stringify({
            success: true,
            errors: [],
            messages: [],
            result: [
              { id: 'rec-1', type: 'TXT', name: 's2025-1._domainkey.acme.com', content: 'old' },
            ],
          })
        );
      }
      return new Response(JSON.stringify({ success: true, errors: [], messages: [], result: {} }));
    });
  });

  it('refuses if flush window has not elapsed', async () => {
    const k = await ops.insertPending({
      domainId: 'd1',
      selector: 's2025-1',
      publicKey: 'p',
      algo: 'rsa2048',
    });
    await ops.setState(k.id, 'retiring', new Date().toISOString());
    const r = await retireOldKey(ops, k.id, client, 'zone-1', 'acme.com');
    expect(r.retired).toBe(false);
    expect(r.reason).toBe('flush_window_not_elapsed');
  });

  it('removes the DNS TXT record after the flush window', async () => {
    const k = await ops.insertPending({
      domainId: 'd1',
      selector: 's2025-1',
      publicKey: 'p',
      algo: 'rsa2048',
    });
    const longAgo = Date.now() - (RETIRE_FLUSH_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000;
    k.activatedAt = new Date(longAgo).toISOString();
    await ops.setState(k.id, 'retiring', new Date(longAgo).toISOString());
    // Force the activation timestamp into the past for the elapsed check.
    (await ops.getById(k.id))!.activatedAt = new Date(longAgo).toISOString();

    const r = await retireOldKey(ops, k.id, client, 'zone-1', 'acme.com');
    expect(r.retired).toBe(true);
    const deletes = calls.filter((c) => c.method === 'DELETE');
    expect(deletes.length).toBeGreaterThan(0);
  });

  it('returns not_found for missing id', async () => {
    const r = await retireOldKey(ops, 'nope', client, 'zone-1', 'acme.com');
    expect(r.retired).toBe(false);
    expect(r.reason).toBe('not_found');
  });
});
