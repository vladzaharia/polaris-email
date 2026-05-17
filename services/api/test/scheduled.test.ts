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
    // anchors are written via packages/object-lock against an
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

  // 8c — Phase 3a persisted the synthetic counter to KV_RATE_LIMIT so a
  // cold-start eviction between cron ticks can no longer mask a sustained
  // outage. We drive worker.scheduled directly through three failures + one
  // recovery and assert the counter / alert behaviour matches contract:
  //
  //   ALERT_THRESHOLD = 2 (see services/api/src/scheduled/synthetic.ts).
  //   Failure 1 → counter=1, no alert.
  //   Failure 2 → counter=2, alert fires.
  //   Failure 3 → counter=3, alert fires (every-call once over threshold).
  //   Success  → counter resets (KV key deleted).
  describe('synthetic counter (8c)', () => {
    function mkKv(): KVNamespace {
      const m = new Map<string, string>();
      return {
        async get(k: string) {
          return m.get(k) ?? null;
        },
        async put(k: string, v: string) {
          m.set(k, v);
        },
        async delete(k: string) {
          m.delete(k);
        },
        // expose for assertions
        _m: m,
      } as unknown as KVNamespace;
    }

    function mkEnv(kv: KVNamespace, alertUrl: string): Env {
      return {
        DB: {} as unknown as D1Database,
        R2: {} as unknown as R2Bucket,
        KV_RATE_LIMIT: kv,
        ANCHOR_R2_PREFIX: 'anchors/',
        ALERT_WEBHOOK: alertUrl,
        API_BASE_URL: 'https://api.example.test',
        MAX_LATENCY_MS: '30000',
      } as unknown as Env;
    }

    it('persists across calls, fires alert at threshold, resets on success', async () => {
      const kv = mkKv();
      const env = mkEnv(kv, 'https://alerts.example.test/hook');
      const fetched: { url: string; body: string }[] = [];
      // Mode is mutable so each call can flip the synthetic /healthz outcome.
      let healthzMode: 'fail' | 'ok' = 'fail';
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.startsWith('https://1.1.1.1/dns-query')) {
          // safeFetch → DoH path; return a routable IP so SSRF lets us through.
          return new Response(JSON.stringify({ Answer: [{ data: '203.0.113.7', type: 1 }] }), {
            status: 200,
            headers: { 'content-type': 'application/dns-json' },
          });
        }
        if (url.includes('alerts.example.test')) {
          fetched.push({ url, body: init?.body ? String(init.body) : '' });
          return new Response('', { status: 200 });
        }
        // Synthetic /healthz probe.
        if (healthzMode === 'fail') return new Response('boom', { status: 500 });
        return new Response('ok', { status: 200 });
      });

      // First failure: counter=1, no alert.
      await worker.scheduled!({ cron: '* * * * *' } as ScheduledEvent, env, ctx);
      expect(await kv.get('synthetic:consecutive_failures')).toBe('1');
      expect(fetched.length).toBe(0);

      // Second failure: counter=2, alert fires.
      await worker.scheduled!({ cron: '* * * * *' } as ScheduledEvent, env, ctx);
      expect(await kv.get('synthetic:consecutive_failures')).toBe('2');
      expect(fetched.length).toBe(1);
      const payload = JSON.parse(fetched[0]!.body) as Record<string, unknown>;
      expect(payload.synthetic_failures).toBe(2);
      expect(payload.service).toBe('polaris-email');

      // Third failure: counter=3, another alert (over threshold every tick).
      await worker.scheduled!({ cron: '* * * * *' } as ScheduledEvent, env, ctx);
      expect(await kv.get('synthetic:consecutive_failures')).toBe('3');
      expect(fetched.length).toBe(2);

      // Recovery: counter resets, KV key deleted, no alert.
      healthzMode = 'ok';
      await worker.scheduled!({ cron: '* * * * *' } as ScheduledEvent, env, ctx);
      expect(await kv.get('synthetic:consecutive_failures')).toBeNull();
      expect(fetched.length).toBe(2);
    });
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
