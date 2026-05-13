import { describe, it, expect, beforeEach } from 'vitest';
import { RevocationDO } from '../src/revocation-do.js';

class FakeStorage {
  private map = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }
}

function makeDo() {
  const storage = new FakeStorage();
  const obj = new RevocationDO({ storage });
  return { storage, obj };
}

async function call(obj: RevocationDO, path: string, init?: RequestInit) {
  return obj.fetch(new Request(`https://do${path}`, init));
}

describe('RevocationDO', () => {
  let obj: RevocationDO;
  beforeEach(() => {
    obj = makeDo().obj;
  });

  it('returns revoked=false initially', async () => {
    const r = await call(obj, '/state');
    expect(r.status).toBe(200);
    const body = (await r.json()) as { revoked: boolean; revoked_at: number | null };
    expect(body.revoked).toBe(false);
    expect(body.revoked_at).toBeNull();
  });

  it('revoke marks state and is idempotent', async () => {
    const r1 = await call(obj, '/revoke', {
      method: 'POST',
      body: JSON.stringify({ by: 'alice', reason: 'leaked' }),
    });
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { revoked: boolean; revoked_at: number; idempotent: boolean };
    expect(b1.revoked).toBe(true);
    expect(b1.idempotent).toBe(false);

    const r2 = await call(obj, '/revoke', {
      method: 'POST',
      body: JSON.stringify({ by: 'bob', reason: 'duplicate' }),
    });
    const b2 = (await r2.json()) as { revoked: boolean; revoked_at: number; idempotent: boolean };
    expect(b2.idempotent).toBe(true);
    expect(b2.revoked_at).toBe(b1.revoked_at);

    const r3 = await call(obj, '/state');
    const b3 = (await r3.json()) as { revoked: boolean };
    expect(b3.revoked).toBe(true);
  });

  it('unrevoke clears state', async () => {
    await call(obj, '/revoke', {
      method: 'POST',
      body: JSON.stringify({ by: 'alice', reason: 'leaked' }),
    });
    const r = await call(obj, '/unrevoke', {
      method: 'POST',
      body: JSON.stringify({ by: 'alice', reason: 'mistake' }),
    });
    expect(r.status).toBe(200);
    const state = (await (await call(obj, '/state')).json()) as {
      revoked: boolean;
      revoked_at: number | null;
    };
    expect(state.revoked).toBe(false);
    expect(state.revoked_at).toBeNull();
  });

  it('history accumulates revoke + unrevoke entries', async () => {
    await call(obj, '/revoke', {
      method: 'POST',
      body: JSON.stringify({ by: 'a', reason: 'r1' }),
    });
    await call(obj, '/unrevoke', {
      method: 'POST',
      body: JSON.stringify({ by: 'b', reason: 'r2' }),
    });
    await call(obj, '/revoke', {
      method: 'POST',
      body: JSON.stringify({ by: 'c', reason: 'r3' }),
    });
    const r = await call(obj, '/history');
    const body = (await r.json()) as { action: string; by: string; reason: string }[];
    expect(body).toHaveLength(3);
    expect(body[0]?.action).toBe('revoke');
    expect(body[1]?.action).toBe('unrevoke');
    expect(body[2]?.action).toBe('revoke');
  });

  it('returns 404 for unknown path', async () => {
    const r = await call(obj, '/garbage');
    expect(r.status).toBe(404);
  });

  it('handles malformed body gracefully', async () => {
    const r = await call(obj, '/revoke', { method: 'POST', body: 'not json' });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { revoked: boolean };
    expect(body.revoked).toBe(true);
  });
});
