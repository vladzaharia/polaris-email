// fast-feedback unit test for the public MTA-STS policy
// handler. Drives `app.fetch()` against the in-memory MockD1 from
// `./mocks.ts` so the dispatch-by-Host logic, body format, and 404
// fall-through paths can be exercised in milliseconds without booting
// workerd. The pool-workers integration test
// (`test/integration/mta-sts-policy.workers.test.ts`) is the canonical
// guarantee against the real D1 schema; this suite catches regressions
// during local edit-test loops.
import { describe, expect, it } from 'vitest';
import { app } from '../src/index.js';
import { mkEnv } from './mocks.js';

const ctx = {
  passThroughOnException: () => undefined,
  waitUntil: (p: Promise<unknown>) => p,
} as unknown as ExecutionContext;

interface SeedOpts {
  name: string;
  mode: 'none' | 'testing' | 'enforce';
  maxAge?: number;
  disabled?: boolean;
}

async function seed(env: ReturnType<typeof mkEnv>, opts: SeedOpts): Promise<void> {
  const isoNow = new Date().toISOString();
  const id =
    '01HX' +
    opts.name
      .replace(/[^a-z0-9]/gi, '')
      .toUpperCase()
      .padEnd(22, 'X')
      .slice(0, 22);
  const zoneId =
    '01HZ' +
    opts.name
      .replace(/[^a-z0-9]/gi, '')
      .toUpperCase()
      .padEnd(22, 'Z')
      .slice(0, 22);
  await env.DB.prepare(
    `INSERT INTO mail_domains
       (id, zone_id, name, status, verified_at, created_at, updated_at,
        mta_sts_mode, mta_sts_max_age, disabled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      zoneId,
      opts.name,
      'verified',
      isoNow,
      isoNow,
      isoNow,
      opts.mode,
      opts.maxAge ?? 86400,
      opts.disabled ? isoNow : null,
    )
    .run();
}

describe('MTA-STS public policy handler (unit, FakeD1)', () => {
  it('serves a testing-mode policy with the canonical RFC 8461 body shape', async () => {
    const env = mkEnv();
    await seed(env, { name: 'acme.test', mode: 'testing', maxAge: 86400 });
    const res = await app.fetch(
      new Request('https://mta-sts.acme.test/.well-known/mta-sts.txt', {
        method: 'GET',
        headers: { host: 'mta-sts.acme.test' },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')?.toLowerCase()).toMatch(/^text\/plain/);
    const body = await res.text();
    expect(body).toBe(
      'version: STSv1\r\nmode: testing\r\nmx: *.mx.cloudflare.net\r\nmax_age: 86400\r\n',
    );
    // No bare LF separators per RFC 8461 §3.2.
    expect(body.split('\r\n').length).toBe(5);
  });

  it('serves enforce-mode with a custom max_age verbatim', async () => {
    const env = mkEnv();
    await seed(env, { name: 'enforce.test', mode: 'enforce', maxAge: 604800 });
    const res = await app.fetch(
      new Request('https://mta-sts.enforce.test/.well-known/mta-sts.txt', {
        method: 'GET',
        headers: { host: 'mta-sts.enforce.test' },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('mode: enforce');
    expect(body).toContain('max_age: 604800');
  });

  it('returns 404 when mta_sts_mode is none', async () => {
    const env = mkEnv();
    await seed(env, { name: 'none.test', mode: 'none' });
    const res = await app.fetch(
      new Request('https://mta-sts.none.test/.well-known/mta-sts.txt', {
        method: 'GET',
        headers: { host: 'mta-sts.none.test' },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 when the domain row is disabled', async () => {
    const env = mkEnv();
    await seed(env, { name: 'disabled.test', mode: 'enforce', disabled: true });
    const res = await app.fetch(
      new Request('https://mta-sts.disabled.test/.well-known/mta-sts.txt', {
        method: 'GET',
        headers: { host: 'mta-sts.disabled.test' },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 when the Host header lacks the mta-sts. prefix', async () => {
    // The route guards against being served on a non-policy host. This
    // matters most when the Worker is reachable on multiple Cloudflare
    // routes (e.g. `api.{tenant}` and `mta-sts.{tenant}`) — a request
    // arriving on the wrong route must not leak the policy.
    const env = mkEnv();
    await seed(env, { name: 'acme.test', mode: 'enforce' });
    const res = await app.fetch(
      new Request('https://api.acme.test/.well-known/mta-sts.txt', {
        method: 'GET',
        headers: { host: 'api.acme.test' },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 for an unknown tenant', async () => {
    const env = mkEnv();
    const res = await app.fetch(
      new Request('https://mta-sts.unknown.test/.well-known/mta-sts.txt', {
        method: 'GET',
        headers: { host: 'mta-sts.unknown.test' },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
  });
});
