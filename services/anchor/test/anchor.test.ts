import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';

function masterB64() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

describe('anchor', () => {
  it('writes an anchor row + R2 object', async () => {
    const r2Writes: { key: string; body: string }[] = [];
    const dbInserts: unknown[] = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind(...p: unknown[]) {
              this._p = p;
              return this;
            },
            _sql: sql,
            _p: [] as unknown[],
            async first() {
              if (sql.includes('audit_log ORDER BY id DESC')) {
                return { id: 42, row_hash: 'a'.repeat(64), at: 100 };
              }
              return null;
            },
            async run() {
              if (sql.includes('INSERT INTO audit_anchors')) {
                dbInserts.push(this._p);
              }
              return { meta: { changes: 1 } };
            },
          };
        },
      } as unknown as D1Database,
      R2: {
        async put(key: string, body: string) {
          r2Writes.push({ key, body });
        },
      } as unknown as R2Bucket,
      ANCHOR_R2_PREFIX: 'anchors/',
      ANCHOR_SIGNING_KEY: masterB64(),
    };
    await worker.scheduled(
      {} as ScheduledEvent,
      env,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );
    expect(r2Writes.length).toBe(1);
    expect(dbInserts.length).toBe(1);
    const payload = JSON.parse(r2Writes[0]!.body);
    expect(payload.last_audit_id).toBe(42);
    expect(payload.sig).toMatch(/^[0-9a-f]{64}$/);
  });
});
