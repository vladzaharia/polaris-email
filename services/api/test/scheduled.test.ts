// Cron-dispatch tests for the scheduled handler embedded in services/api.
// Originally lived at services/cron/test/cron.test.ts; folded in during the
// B1 worker consolidation. Drives the default-export `worker.scheduled(...)`
// so the production wiring (router + Env shape) is exercised.
import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import type { Env } from '../src/env.js';

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

function masterB64() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

describe('scheduled dispatch', () => {
  it('hourly cron runs the anchor handler', async () => {
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
      ALERT_WEBHOOK: '',
      API_BASE_URL: '',
      MAX_LATENCY_MS: '30000',
    } as unknown as Env;
    await worker.scheduled!({ cron: '0 * * * *' } as ScheduledEvent, env, ctx);
    expect(r2Writes.length).toBe(1);
    expect(dbInserts.length).toBe(1);
  });

  it('weekly cron runs staleness (empty audit log → no alert)', async () => {
    const env = {
      DB: {
        prepare() {
          return {
            bind() {
              return this;
            },
            async first() {
              return { at: null };
            },
          };
        },
      } as unknown as D1Database,
      R2: {} as unknown as R2Bucket,
      ANCHOR_R2_PREFIX: 'anchors/',
      ALERT_WEBHOOK: '',
      API_BASE_URL: '',
      MAX_LATENCY_MS: '30000',
    } as unknown as Env;
    await expect(
      worker.scheduled!({ cron: '0 9 * * 1' } as ScheduledEvent, env, ctx),
    ).resolves.toBeUndefined();
  });

  it('per-minute cron runs synthetic (no base url → returns OK)', async () => {
    const env = {
      DB: {} as unknown as D1Database,
      R2: {} as unknown as R2Bucket,
      ANCHOR_R2_PREFIX: 'anchors/',
      ALERT_WEBHOOK: '',
      API_BASE_URL: '',
      MAX_LATENCY_MS: '30000',
    } as unknown as Env;
    await expect(
      worker.scheduled!({ cron: '* * * * *' } as ScheduledEvent, env, ctx),
    ).resolves.toBeUndefined();
  });

  it('nightly cron runs janitor (empty tenants → no-op)', async () => {
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return this;
            },
            async all() {
              if (sql.includes('FROM mailboxes')) return { results: [], meta: {} };
              return { results: [], meta: {} };
            },
            async run() {
              return { meta: { changes: 0 } };
            },
          };
        },
      } as unknown as D1Database,
      R2: {
        async delete() {},
      } as unknown as R2Bucket,
      ANCHOR_R2_PREFIX: 'anchors/',
      ALERT_WEBHOOK: '',
      API_BASE_URL: '',
      MAX_LATENCY_MS: '30000',
    } as unknown as Env;
    await expect(
      worker.scheduled!({ cron: '0 3 * * *' } as ScheduledEvent, env, ctx),
    ).resolves.toBeUndefined();
  });
});
