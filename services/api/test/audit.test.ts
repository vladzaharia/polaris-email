// Audit chain tests — Phase A7 hardening.
// Covers: (1) sequential writes produce a verifiable chain;
//         (2) concurrent writers don't fork the chain (CAS retry).
import { describe, expect, it } from 'vitest';
import { audit, verifyChain } from '../src/audit.js';
import { mkEnv, MockD1 } from './mocks.js';

describe('audit() hash-chain CAS', () => {
  it('writes a verifiable chain when called serially', async () => {
    const env = mkEnv();
    await audit(env, { actor: 'system', action: 'mailbox.create', target: 'm1', at: 1 });
    await audit(env, { actor: 'system', action: 'mailbox.create', target: 'm2', at: 2 });
    await audit(env, { actor: 'system', action: 'mailbox.create', target: 'm3', at: 3 });

    const result = await verifyChain(env);
    expect(result.ok).toBe(true);

    const db = env.DB as unknown as MockD1;
    const rows = db.tables.get('audit_log') ?? [];
    // Genesis row (id=0) is pre-seeded by the mock + three inserts.
    expect(rows.length).toBe(4);
  });

  it('CAS retries when a concurrent writer beats us and chain stays linear', async () => {
    const env = mkEnv();
    const db = env.DB as unknown as MockD1;

    // Fire two writes "concurrently" — under the mock these resolve
    // sequentially but each issues its own SELECT-then-CAS-INSERT pair, so
    // we can observe whether the chain forks (it must not).
    const writers = [
      audit(env, { actor: 'a', action: 'mailbox.create', target: 'x', at: 100 }),
      audit(env, { actor: 'b', action: 'mailbox.create', target: 'y', at: 200 }),
      audit(env, { actor: 'c', action: 'mailbox.create', target: 'z', at: 300 }),
    ];
    await Promise.all(writers);

    const result = await verifyChain(env);
    expect(result.ok).toBe(true);

    const rows = db.tables.get('audit_log') ?? [];
    // Genesis + 3 writes.
    expect(rows.length).toBe(4);
    // All row_hash values should be distinct — a forked chain would collide
    // on prev_hash but row_hashes diverge anyway; we mainly assert chain
    // validity above and check no rows were lost here.
    const hashes = new Set(rows.map((r) => String(r['row_hash'])));
    expect(hashes.size).toBe(rows.length);
  });

  it('CAS aborts the INSERT when the tip has moved (simulated race)', async () => {
    // This exercise pokes the mock directly to force a tip mismatch. We
    // seed an extra row between our SELECT and INSERT and confirm the
    // INSERT writes zero rows.
    const env = mkEnv();
    const db = env.DB as unknown as MockD1;

    // Pretend we observed tip id=0 (the genesis row).
    // Then before our CAS INSERT, another writer appends.
    db.tables.get('audit_log')!.push({
      id: 1,
      actor: 'other',
      action: 'mailbox.create',
      target: null,
      meta: '{}',
      prev_hash: '0'.repeat(64),
      row_hash: 'deadbeef',
      at: 1,
    });

    // Now run a CAS INSERT with expected max id = 0 (stale). It should
    // write zero rows because the live MAX(id) is now 1.
    const res = await env.DB.prepare(
      `INSERT INTO audit_log (actor, action, target, meta, prev_hash, row_hash, at)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE (SELECT IFNULL(MAX(id), -1) FROM audit_log) = ?`,
    )
      .bind('us', 'mailbox.create', null, '{}', '0'.repeat(64), 'cafef00d', 1, 0)
      .run();
    expect(res.meta?.changes ?? 0).toBe(0);
  });
});
