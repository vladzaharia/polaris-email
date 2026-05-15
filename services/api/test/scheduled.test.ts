// Cron-dispatch tests for the scheduled handler embedded in services/api.
// Originally lived at services/cron/test/cron.test.ts; folded in during the
// B1 worker consolidation. Drives the default-export `worker.scheduled(...)`
// so the production wiring (router + Env shape) is exercised.
import { afterEach, describe, expect, it, vi } from 'vitest';
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('scheduled dispatch', () => {
  it('hourly cron runs the anchor handler (writes via SigV4 PUT to B2)', async () => {
    // Phase O1: anchors are written via packages/object-lock against an
    // external S3 endpoint. Capture the signed PUT by mocking global fetch.
    const fetched: Request[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      fetched.push(new Request(String(input), init as RequestInit));
      return new Response('', { status: 200 });
    });
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
      R2: {} as unknown as R2Bucket,
      ANCHOR_R2_PREFIX: 'anchors/',
      ANCHOR_SIGNING_KEY: masterB64(),
      ANCHOR_S3_ENDPOINT: 'https://s3.us-west-005.backblazeb2.com',
      ANCHOR_S3_BUCKET: 'polaris-anchors-test',
      ANCHOR_S3_REGION: 'us-west-005',
      ANCHOR_S3_ACCESS_KEY_ID: 'test-access-key',
      ANCHOR_S3_SECRET_ACCESS_KEY: 'test-secret-key',
      ALERT_WEBHOOK: '',
      API_BASE_URL: '',
      MAX_LATENCY_MS: '30000',
    } as unknown as Env;
    await worker.scheduled!({ cron: '0 * * * *' } as ScheduledEvent, env, ctx);
    expect(fetched.length).toBe(1);
    expect(fetched[0]!.method).toBe('PUT');
    expect(fetched[0]!.url).toMatch(
      /^https:\/\/s3\.us-west-005\.backblazeb2\.com\/polaris-anchors-test\/anchors\//,
    );
    expect(fetched[0]!.headers.get('x-amz-object-lock-mode')).toBe('COMPLIANCE');
    expect(fetched[0]!.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 /);
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
