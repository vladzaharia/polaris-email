import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  revocationCheck,
  revoke,
  _clearRevocationCacheForTests,
  type RevocationEnv,
} from '../src/index.js';

class FakeKV {
  store = new Map<string, string>();
  putCalls = 0;
  getCalls = 0;
  deleteCalls = 0;

  async get(key: string): Promise<string | null> {
    this.getCalls++;
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.putCalls++;
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.deleteCalls++;
    this.store.delete(key);
  }
}

function mkEnv(): { env: RevocationEnv; revocations: FakeKV; keyCache: FakeKV } {
  const revocations = new FakeKV();
  const keyCache = new FakeKV();
  const env: RevocationEnv = {
    KV_REVOCATIONS: revocations as unknown as KVNamespace,
    KV_KEY_CACHE: keyCache as unknown as KVNamespace,
  };
  return { env, revocations, keyCache };
}

describe('revocationCheck', () => {
  beforeEach(() => {
    _clearRevocationCacheForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    _clearRevocationCacheForTests();
  });

  it('returns false when principal is not revoked', async () => {
    const { env, revocations } = mkEnv();
    const result = await revocationCheck(env, 'p1');
    expect(result).toBe(false);
    expect(revocations.getCalls).toBe(1);
  });

  it('returns true when principal has a revocation entry', async () => {
    const { env, revocations } = mkEnv();
    revocations.store.set('p1', String(Date.now()));
    const result = await revocationCheck(env, 'p1');
    expect(result).toBe(true);
  });

  it('caches the result for 60s and skips KV after first read', async () => {
    const { env, revocations } = mkEnv();
    await revocationCheck(env, 'p1');
    await revocationCheck(env, 'p1');
    await revocationCheck(env, 'p1');
    expect(revocations.getCalls).toBe(1);
  });

  it('cache TTL expires after 60s and re-reads KV', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    const { env, revocations } = mkEnv();
    await revocationCheck(env, 'p1');
    expect(revocations.getCalls).toBe(1);

    // Advance just under TTL — still cached.
    vi.setSystemTime(new Date('2025-01-01T00:00:59Z'));
    await revocationCheck(env, 'p1');
    expect(revocations.getCalls).toBe(1);

    // Advance past TTL — re-reads.
    vi.setSystemTime(new Date('2025-01-01T00:01:01Z'));
    await revocationCheck(env, 'p1');
    expect(revocations.getCalls).toBe(2);
  });

  it('cache is keyed per principalId', async () => {
    const { env, revocations } = mkEnv();
    await revocationCheck(env, 'p1');
    await revocationCheck(env, 'p2');
    expect(revocations.getCalls).toBe(2);
  });
});

describe('revoke', () => {
  beforeEach(() => {
    _clearRevocationCacheForTests();
  });

  it('writes principalId → timestamp to KV_REVOCATIONS', async () => {
    const { env, revocations } = mkEnv();
    await revoke(env, 'p1');
    expect(revocations.store.has('p1')).toBe(true);
    const value = revocations.store.get('p1');
    expect(value).toBeDefined();
    expect(Number.isFinite(Number(value))).toBe(true);
  });

  it('primes the in-memory cache so subsequent checks return true without KV read', async () => {
    const { env, revocations } = mkEnv();
    await revoke(env, 'p1');
    const before = revocations.getCalls;
    const result = await revocationCheck(env, 'p1');
    expect(result).toBe(true);
    // Cache should be primed: no extra KV read for the check.
    expect(revocations.getCalls).toBe(before);
  });

  it('overrides a previous not-revoked cache entry', async () => {
    const { env } = mkEnv();
    expect(await revocationCheck(env, 'p1')).toBe(false);
    await revoke(env, 'p1');
    expect(await revocationCheck(env, 'p1')).toBe(true);
  });
});
