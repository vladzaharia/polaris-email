// Phase C.9 — pool-workers integration test for the public MTA-STS
// policy handler at `https://mta-sts.{tenant}/.well-known/mta-sts.txt`.
//
// The route is intentionally PUBLIC (unauthenticated) — sender MTAs fetch
// it without any credentials per RFC 8461 §3.3. The test drives
// `worker.fetch()` directly against the same Hono entrypoint that ships to
// production, with D1 migrations applied so the `mail_domains.mta_sts_*`
// columns exist and behave like the real schema.
//
// What we assert per row of the matrix:
//   - `mta_sts_mode='testing'`  → 200, `mode: testing` in body
//   - `mta_sts_mode='enforce'`  → 200, `mode: enforce` in body
//   - `mta_sts_mode='none'`     → 404 (don't surface)
//   - `disabled_at IS NOT NULL` → 404 (domain disabled)
//   - Host without `mta-sts.` prefix → 404 (foreign host)
//   - Unknown tenant            → 404
//   - Content-Type starts with `text/plain`
//   - Body uses CRLF separators (\r\n) — RFC 8461 §3.2 normative
//   - Custom `mta_sts_max_age` value appears verbatim
import { applyD1Migrations, createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import worker from '../../src/index.js';
import type { Env } from '../../src/env.js';

interface TestEnv extends Env {
  DB: D1Database;
}

const testEnv = env as unknown as TestEnv;

function buildExecutionContext(): ExecutionContext {
  return createExecutionContext();
}

async function callWorker(req: Request): Promise<Response> {
  const ctx = buildExecutionContext();
  return worker.fetch(req, testEnv as unknown as Env, ctx);
}

interface SeedOpts {
  domain: string;
  mode: 'none' | 'testing' | 'enforce';
  maxAge?: number;
  disabled?: boolean;
}

let seedCounter = 0;
async function seedDomain(opts: SeedOpts): Promise<void> {
  seedCounter += 1;
  const seq = String(seedCounter).padStart(4, '0');
  const id = `01HX00DOM${seq}000000000000C9`.slice(0, 26);
  const zoneId = `01HX00ZON${seq}000000000000C9`.slice(0, 26);
  const nowIso = new Date().toISOString();
  await testEnv.DB.prepare(
    `INSERT INTO zones (id, cf_zone_id, name, created_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(zoneId, `cfz-c9-${seq}`, opts.domain, nowIso)
    .run();
  await testEnv.DB.prepare(
    `INSERT INTO mail_domains
       (id, zone_id, name, status, verified_at, created_at, updated_at,
        mta_sts_mode, mta_sts_max_age, disabled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      zoneId,
      opts.domain,
      'verified',
      nowIso,
      nowIso,
      nowIso,
      opts.mode,
      opts.maxAge ?? 86400,
      opts.disabled ? nowIso : null,
    )
    .run();
}

beforeAll(async () => {
  const migrations = inject('migrations');
  await applyD1Migrations(testEnv.DB, migrations);
});

describe('services/api MTA-STS public policy handler (pool-workers)', () => {
  it('serves a testing-mode policy for an onboarded tenant', async () => {
    const domain = 'acme-testing.test';
    await seedDomain({ domain, mode: 'testing', maxAge: 86400 });

    const res = await callWorker(
      new Request(`https://mta-sts.${domain}/.well-known/mta-sts.txt`, {
        method: 'GET',
        headers: { host: `mta-sts.${domain}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')?.toLowerCase()).toMatch(/^text\/plain/);
    const body = await res.text();
    // RFC 8461 §3.2: CRLF-separated key/value pairs.
    expect(body).toContain('\r\n');
    expect(body).not.toMatch(/[^\r]\n/); // no bare LF
    expect(body).toContain('version: STSv1');
    expect(body).toContain('mode: testing');
    expect(body).toContain('mx: *.mx.cloudflare.net');
    expect(body).toContain('max_age: 86400');
  });

  it('serves an enforce-mode policy with a custom max_age', async () => {
    const domain = 'acme-enforce.test';
    await seedDomain({ domain, mode: 'enforce', maxAge: 604800 });

    const res = await callWorker(
      new Request(`https://mta-sts.${domain}/.well-known/mta-sts.txt`, {
        method: 'GET',
        headers: { host: `mta-sts.${domain}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('mode: enforce');
    expect(body).toContain('max_age: 604800');
  });

  it('returns 404 when the domain is in mode=none', async () => {
    const domain = 'acme-none.test';
    await seedDomain({ domain, mode: 'none' });

    const res = await callWorker(
      new Request(`https://mta-sts.${domain}/.well-known/mta-sts.txt`, {
        method: 'GET',
        headers: { host: `mta-sts.${domain}` },
      }),
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 when the domain is disabled', async () => {
    const domain = 'acme-disabled.test';
    await seedDomain({ domain, mode: 'enforce', disabled: true });

    const res = await callWorker(
      new Request(`https://mta-sts.${domain}/.well-known/mta-sts.txt`, {
        method: 'GET',
        headers: { host: `mta-sts.${domain}` },
      }),
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 for an unknown tenant', async () => {
    const res = await callWorker(
      new Request(`https://mta-sts.unknown-tenant.test/.well-known/mta-sts.txt`, {
        method: 'GET',
        headers: { host: `mta-sts.unknown-tenant.test` },
      }),
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 when the Host header is missing the mta-sts. prefix', async () => {
    // Even if the domain exists with MTA-STS enabled, the handler must
    // short-circuit when the request was not dispatched via the policy
    // host. This protects the route from being exposed accidentally if a
    // future Workers Route mapping changes upstream.
    const domain = 'acme-prefix.test';
    await seedDomain({ domain, mode: 'enforce' });
    const res = await callWorker(
      new Request(`https://api.${domain}/.well-known/mta-sts.txt`, {
        method: 'GET',
        headers: { host: `api.${domain}` },
      }),
    );
    expect(res.status).toBe(404);
  });

  it('handles a mixed-case Host header (RFC 7230 §5.4)', async () => {
    const domain = 'acme-mixedcase.test';
    await seedDomain({ domain, mode: 'testing' });
    const res = await callWorker(
      new Request(`https://mta-sts.${domain}/.well-known/mta-sts.txt`, {
        method: 'GET',
        headers: { host: `MTA-STS.${domain.toUpperCase()}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('mode: testing');
  });

  it('healthz still resolves through the same Hono app', async () => {
    // Sanity check: mounting the public route at root must not shadow
    // other routes. `/healthz` is the canonical liveness probe.
    const res = await callWorker(new Request('https://x/healthz'));
    expect(res.status).toBe(200);
  });
});
