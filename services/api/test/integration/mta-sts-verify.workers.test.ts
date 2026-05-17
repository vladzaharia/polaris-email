// Phase C.11-12 — integration tests for domain.create defaults and the
// MTA-STS / TLS-RPT extensions to the domain-verify endpoint.
//
// Scope:
//   - POST /v1/admin/domains records `mta_sts_*` / `tlsrpt_*` intent on every
//     new row (C.11).
//   - POST /v1/admin/domains/:id/verify runs the MTA-STS + TLS-RPT sub-blocks
//     in addition to the existing CNAME + MX checks (C.12).
//   - Drift detection: when `mta_sts_policy_id` is bumped (e.g. by /promote)
//     but the DoH TXT still returns the old id, verify surfaces an
//     operator-action hint pointing at /mta-sts/enable.
//   - `mta_sts_verified_at` / `tlsrpt_verified_at` columns are persisted
//     independently of the overall verify outcome.
//
// CF + DoH fetch interception strategy:
//   We patch `globalThis.fetch` with a stateful stub that responds to:
//     - Cloudflare REST API (Email Routing DNS list, dns_records,
//       workers/domains) — driven by the cf-api package.
//     - DoH (cloudflare-dns.com + 1.1.1.1) — returns canned answers per
//       record name configured by each test.
//     - HTTPS `mta-sts.{tenant}/.well-known/mta-sts.txt` — returns a
//       canned policy body per test.
//   The shape mirrors `mta-sts-admin.workers.test.ts` — see
//   the comments there for the broader rationale.
import { applyD1Migrations, createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { sign, generateNonce } from '@polaris-email/hmac';
import worker from '../../src/index.js';
import type { Env } from '../../src/env.js';

interface TestEnv extends Env {
  DB: D1Database;
}

const testEnv = env as unknown as TestEnv;

const POLARIS_SECRET = 'phase-c11-control-plane-secret';
const ARGON2_PEPPER = 'phase-c11-pepper';
const CF_API_TOKEN = 'phase-c11-cf-token';
const CF_ACCOUNT_ID = 'phase-c11-cf-account';

function buildExecutionContext(): ExecutionContext {
  return createExecutionContext();
}

async function signedRequest(
  url: string,
  body: string,
  method: string,
  secret: string,
  keyId: string | null,
): Promise<Request> {
  const u = new URL(url);
  const ts = String(Date.now());
  const nonce = generateNonce();
  const sig = await sign(
    {
      direction: 'polaris-api',
      method,
      path: u.pathname,
      query: u.search,
      ts,
      nonce,
      body,
    },
    secret,
  );
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-polaris-ts': ts,
    'x-polaris-nonce': nonce,
    'x-polaris-sig': sig,
  };
  if (keyId) headers['x-polaris-key-id'] = keyId;
  return new Request(url, {
    method,
    headers,
    body: method === 'GET' ? undefined : body,
  });
}

async function callWorker(req: Request): Promise<Response> {
  const ctx = buildExecutionContext();
  return worker.fetch(req, testEnv as unknown as Env, ctx);
}

interface BootstrapResult {
  admin_key_id: string;
  admin_key_secret: string;
  mailbox_id: string;
}

async function bootstrap(): Promise<BootstrapResult> {
  const req = await signedRequest(
    'https://x/v1/admin/bootstrap',
    '{}',
    'POST',
    POLARIS_SECRET,
    null,
  );
  const res = await callWorker(req);
  if (res.status !== 200) {
    throw new Error(`bootstrap failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as BootstrapResult;
}

// ---------- Stateful fetch stub ----------
//
// Two state buckets:
//   - `dohTxt`     keyed by record name → array of TXT data strings.
//   - `policyBody` keyed by `mta-sts.{tenant}` → { status, contentType, body }.
// Cloudflare REST records live in their own map for /enable provisioning.
//
// Tests mutate these between calls to simulate publish / drift / re-publish
// without unsetting the stub.

interface DohState {
  // record name (e.g. `_mta-sts.foo.test`) → list of TXT `data` strings
  // already wrapped in quotes per DoH protocol.
  txt: Map<string, string[]>;
  // record name (e.g. `enable.example.test`) → list of CNAME / MX answers.
  cname: Map<string, string[]>;
  mx: Map<string, string[]>;
}

interface PolicyState {
  // hostname (e.g. `mta-sts.foo.test`) → fetch response shape.
  policy: Map<string, { status: number; contentType: string; body: string }>;
}

type FetchStubHandle = {
  doh: DohState;
  pol: PolicyState;
  // Cloudflare REST stubs (mirrors C.10 stub state):
  records: Map<string, { id: string; type: string; name: string; content: string }>;
};

function installVerifyFetchStub(): FetchStubHandle {
  const handle: FetchStubHandle = {
    doh: {
      txt: new Map(),
      cname: new Map(),
      mx: new Map(),
    },
    pol: { policy: new Map() },
    records: new Map(),
  };
  let nextId = 1;
  let workerDomain: { id: string; hostname: string; zone_id: string; service: string } | null =
    null;

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();

    // ---- DoH (cloudflare-dns.com OR 1.1.1.1) ----
    if (
      url.startsWith('https://cloudflare-dns.com/dns-query') ||
      url.startsWith('https://1.1.1.1/dns-query')
    ) {
      const u = new URL(url);
      const name = u.searchParams.get('name') ?? '';
      const type = (u.searchParams.get('type') ?? '').toUpperCase();
      if (type === 'TXT') {
        const data = handle.doh.txt.get(name) ?? [];
        return new Response(
          JSON.stringify({
            Status: 0,
            Answer: data.map((d) => ({ name, type: 16, TTL: 60, data: d })),
          }),
          { status: 200, headers: { 'content-type': 'application/dns-json' } },
        );
      }
      if (type === 'CNAME') {
        const data = handle.doh.cname.get(name) ?? [];
        return new Response(
          JSON.stringify({
            Status: 0,
            Answer: data.map((d) => ({ name, type: 5, TTL: 60, data: d })),
          }),
          { status: 200, headers: { 'content-type': 'application/dns-json' } },
        );
      }
      if (type === 'MX') {
        const data = handle.doh.mx.get(name) ?? [];
        return new Response(
          JSON.stringify({
            Status: 0,
            Answer: data.map((d) => ({ name, type: 15, TTL: 60, data: d })),
          }),
          { status: 200, headers: { 'content-type': 'application/dns-json' } },
        );
      }
      return new Response(JSON.stringify({ Status: 0, Answer: [] }), {
        status: 200,
        headers: { 'content-type': 'application/dns-json' },
      });
    }

    // ---- HTTPS policy file fetch (mta-sts.{tenant}/.well-known/mta-sts.txt) ----
    const policyMatch = url.match(/^https:\/\/(mta-sts\.[^/]+)\/\.well-known\/mta-sts\.txt$/i);
    if (policyMatch) {
      const host = policyMatch[1] ?? '';
      const cfg = handle.pol.policy.get(host);
      if (!cfg) {
        return new Response('not found', { status: 404 });
      }
      return new Response(cfg.body, {
        status: cfg.status,
        headers: { 'content-type': cfg.contentType },
      });
    }

    // ---- Cloudflare REST (mirrors C.10 stub) ----
    if (url.startsWith('https://api.cloudflare.com/client/v4/')) {
      const bodyText =
        typeof init?.body === 'string' ? init.body : init?.body ? String(init.body) : null;

      // Email Routing DNS list (used by the verify endpoint).
      if (url.match(/\/zones\/[^/]+\/email\/routing\/dns$/) && method === 'GET') {
        return new Response(JSON.stringify({ success: true, result: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      const zoneMatch = url.match(/\/zones\/([^/]+)\/dns_records(?:\?([^#]*))?$/);
      if (zoneMatch && method === 'GET') {
        const params = new URLSearchParams(zoneMatch[2] ?? '');
        const type = params.get('type') ?? '';
        const name = params.get('name') ?? '';
        const matches: { id: string; type: string; name: string; content: string }[] = [];
        for (const r of handle.records.values()) {
          if (r.type === type && r.name === name) matches.push(r);
        }
        return new Response(
          JSON.stringify({ success: true, result: matches.map((r) => ({ ...r })) }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (zoneMatch && method === 'POST') {
        const parsed = JSON.parse(bodyText ?? '{}');
        const id = `rec-${nextId++}`;
        const rec = { id, type: parsed.type, name: parsed.name, content: parsed.content };
        handle.records.set(`${rec.type}:${rec.name}`, rec);
        return new Response(JSON.stringify({ success: true, result: { ...rec } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const dnsIdMatch = url.match(/\/zones\/([^/]+)\/dns_records\/([^/?#]+)$/);
      if (dnsIdMatch && method === 'PATCH') {
        const parsed = JSON.parse(bodyText ?? '{}');
        const recId = dnsIdMatch[2];
        for (const [k, v] of handle.records) {
          if (v.id === recId) {
            const updated = {
              id: recId,
              type: parsed.type ?? v.type,
              name: parsed.name ?? v.name,
              content: parsed.content ?? v.content,
            };
            handle.records.set(k, updated);
            return new Response(JSON.stringify({ success: true, result: { ...updated } }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
        }
        return new Response(
          JSON.stringify({ success: false, errors: [{ code: 7003, message: 'not found' }] }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        );
      }

      // Worker custom domains.
      const domGetMatch = url.match(/\/accounts\/[^/]+\/workers\/domains(?:\?([^#]*))?$/);
      if (domGetMatch && method === 'GET') {
        const params = new URLSearchParams(domGetMatch[1] ?? '');
        const hostname = params.get('hostname');
        const matches = workerDomain && workerDomain.hostname === hostname ? [workerDomain] : [];
        return new Response(JSON.stringify({ success: true, result: matches }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (domGetMatch && method === 'PUT') {
        const parsed = JSON.parse(bodyText ?? '{}');
        workerDomain = {
          id: `wd-${nextId++}`,
          hostname: parsed.hostname,
          zone_id: parsed.zone_id,
          service: parsed.service,
        };
        return new Response(JSON.stringify({ success: true, result: { ...workerDomain } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({ success: false, errors: [{ code: 9999, message: 'no stub' }] }),
        { status: 501, headers: { 'content-type': 'application/json' } },
      );
    }

    return new Response('unexpected upstream', { status: 502 });
  });
  return handle;
}

interface SeedDomainOpts {
  domain: string;
  status?: string;
  cfZoneId?: string | null;
  mtaStsMode?: 'none' | 'testing' | 'enforce';
  mtaStsPolicyId?: string | null;
  tlsrptEnabled?: boolean;
  tlsrptRua?: string | null;
}

let domainSeq = 0;
async function seedDomain(opts: SeedDomainOpts): Promise<string> {
  domainSeq += 1;
  const seq = String(domainSeq).padStart(4, '0');
  const id = `01HX11DOM${seq}000000000000C0`.slice(0, 26);
  const zoneId = `01HX11ZON${seq}000000000000C0`.slice(0, 26);
  const nowIso = new Date().toISOString();
  const cfZoneId = opts.cfZoneId === undefined ? `cf-zone-${seq}` : opts.cfZoneId;
  await testEnv.DB.prepare(
    `INSERT INTO zones (id, cf_zone_id, name, created_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(zoneId, `cfz-c11-${seq}`, opts.domain, nowIso)
    .run();
  await testEnv.DB.prepare(
    `INSERT INTO mail_domains
       (id, zone_id, name, status, cf_zone_id, inbound_enabled, verified_at,
        created_at, updated_at, mta_sts_mode, mta_sts_policy_id,
        tlsrpt_enabled, tlsrpt_rua)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      zoneId,
      opts.domain,
      opts.status ?? 'verified',
      cfZoneId,
      1,
      opts.status === 'verified' || opts.status === undefined ? nowIso : null,
      nowIso,
      nowIso,
      opts.mtaStsMode ?? 'none',
      opts.mtaStsPolicyId ?? null,
      opts.tlsrptEnabled ? 1 : 0,
      opts.tlsrptRua ?? null,
    )
    .run();
  return id;
}

let adminCreds: BootstrapResult;

beforeAll(async () => {
  const migrations = inject('migrations');
  await applyD1Migrations(testEnv.DB, migrations);
  (testEnv as unknown as Record<string, unknown>).POLARIS_SECRET_A = POLARIS_SECRET;
  (testEnv as unknown as Record<string, unknown>).ARGON2_PEPPER = ARGON2_PEPPER;
  adminCreds = await bootstrap();
});

beforeEach(() => {
  (testEnv as unknown as Record<string, unknown>).CF_API_TOKEN = CF_API_TOKEN;
  (testEnv as unknown as Record<string, unknown>).CF_ACCOUNT_ID = CF_ACCOUNT_ID;
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface VerifyResponseBody {
  id: string;
  status: string;
  message?: string;
  verified_at?: number;
  checks: { name: string; ok: boolean; expected: string; actual: string }[];
}

async function callVerify(domainId: string): Promise<VerifyResponseBody> {
  const res = await callWorker(
    await signedRequest(
      `https://x/v1/admin/domains/${domainId}/verify`,
      '{}',
      'POST',
      adminCreds.admin_key_secret,
      adminCreds.admin_key_id,
    ),
  );
  const txt = await res.text();
  if (!res.ok && res.status !== 200) {
    // Verify returns 200 even on incomplete — anything else is a test bug.
    throw new Error(`verify ${res.status}: ${txt}`);
  }
  return JSON.parse(txt) as VerifyResponseBody;
}

async function readDomainFull(id: string): Promise<{
  mta_sts_mode: string;
  mta_sts_policy_id: string | null;
  mta_sts_verified_at: string | null;
  tlsrpt_enabled: number;
  tlsrpt_rua: string | null;
  tlsrpt_verified_at: string | null;
}> {
  const row = await testEnv.DB.prepare(
    `SELECT mta_sts_mode, mta_sts_policy_id, mta_sts_verified_at,
            tlsrpt_enabled, tlsrpt_rua, tlsrpt_verified_at
     FROM mail_domains WHERE id = ?`,
  )
    .bind(id)
    .first<{
      mta_sts_mode: string;
      mta_sts_policy_id: string | null;
      mta_sts_verified_at: string | null;
      tlsrpt_enabled: number;
      tlsrpt_rua: string | null;
      tlsrpt_verified_at: string | null;
    }>();
  if (!row) throw new Error(`domain ${id} not found`);
  return row;
}

describe('services/api domain.create defaults', () => {
  it('seeds mta_sts_mode=testing, fresh policy_id, tlsrpt_enabled=1, default rua', async () => {
    const admin = adminCreds;
    const name = `c11-create-${Date.now()}.example.test`;

    const res = await callWorker(
      await signedRequest(
        'https://x/v1/admin/domains',
        JSON.stringify({ name }),
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    expect(res.status, `expected 201, got ${res.status}: ${await res.clone().text()}`).toBe(201);
    const body = (await res.json()) as {
      id: string;
      mta_sts_mode: string;
      mta_sts_policy_id: string;
      mta_sts_max_age: number;
      tlsrpt_enabled: number;
      tlsrpt_rua: string;
      mta_sts_provisioning_hint: string;
      tlsrpt_provisioning_hint: string;
    };
    expect(body.mta_sts_mode).toBe('testing');
    expect(body.mta_sts_policy_id).toMatch(/^\d{8}T\d{6}Z$/);
    expect(body.mta_sts_max_age).toBe(86_400);
    expect(body.tlsrpt_enabled).toBe(1);
    // wrangler.test.jsonc sets TLSRPT_DEFAULT_RUA = 'mailto:tlsrpt@test.local'.
    expect(body.tlsrpt_rua).toBe(testEnv.TLSRPT_DEFAULT_RUA ?? 'mailto:tlsrpt@plrs.im');
    // Hints reference the lifecycle endpoints — these strings drive the
    // panel's empty-state copy, so guard against accidental renames.
    expect(body.mta_sts_provisioning_hint).toContain('/mta-sts/enable');
    expect(body.tlsrpt_provisioning_hint).toContain('/tls-rpt/enable');

    const row = await readDomainFull(body.id);
    expect(row.mta_sts_mode).toBe('testing');
    expect(row.mta_sts_policy_id).toBe(body.mta_sts_policy_id);
    expect(row.tlsrpt_enabled).toBe(1);
    expect(row.tlsrpt_rua).toBe(body.tlsrpt_rua);
  });

  it('bulk-onboard applies the same defaults to every row', async () => {
    const admin = adminCreds;
    const names = [
      `c11-bulk-a-${Date.now()}.example.test`,
      `c11-bulk-b-${Date.now()}.example.test`,
    ];

    const res = await callWorker(
      await signedRequest(
        'https://x/v1/admin/domains/bulk-onboard',
        JSON.stringify({ names }),
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: { name: string; id?: string; error?: string }[];
    };
    expect(body.results.filter((r) => r.id).length).toBe(2);

    for (const r of body.results) {
      if (!r.id) continue;
      const row = await readDomainFull(r.id);
      expect(row.mta_sts_mode).toBe('testing');
      expect(row.mta_sts_policy_id).toMatch(/^\d{8}T\d{6}Z$/);
      expect(row.tlsrpt_enabled).toBe(1);
      expect(row.tlsrpt_rua).toBe(testEnv.TLSRPT_DEFAULT_RUA ?? 'mailto:tlsrpt@plrs.im');
    }
    // Distinct policy IDs are not guaranteed (they collapse to the same ISO
    // second if minted close together); the test only asserts the format.
  });
});

describe('services/api domain verify MTA-STS + TLS-RPT', () => {
  it('mode=testing with no published records → fail + operator-action hint', async () => {
    const stub = installVerifyFetchStub();
    const policyId = '20260515T120000Z';
    const id = await seedDomain({
      domain: 'no-records.example.test',
      mtaStsMode: 'testing',
      mtaStsPolicyId: policyId,
      tlsrptEnabled: true,
      tlsrptRua: 'mailto:tlsrpt@test.local',
    });
    // No DoH TXT entries seeded → verifyMtaSts / verifyTlsRpt fail.
    // Seed MX so existing block passes (we want to isolate the MTA-STS hint).
    stub.doh.mx.set('no-records.example.test', [
      '10 route1.mx.cloudflare.net.',
      '20 route2.mx.cloudflare.net.',
      '30 route3.mx.cloudflare.net.',
    ]);

    const out = await callVerify(id);

    const mtaStsHint = out.checks.find((c) => c.name.startsWith('mta-sts:operator-action:'));
    expect(mtaStsHint, 'mta-sts operator-action hint missing').toBeDefined();
    expect(mtaStsHint!.ok).toBe(false);
    expect(mtaStsHint!.expected).toContain(`policy_id=${policyId}`);
    expect(mtaStsHint!.actual).toContain('POST /v1/admin/domains/');
    expect(mtaStsHint!.actual).toContain('/mta-sts/enable');

    const tlsRptHint = out.checks.find((c) => c.name.startsWith('tls-rpt:operator-action:'));
    expect(tlsRptHint).toBeDefined();
    expect(tlsRptHint!.actual).toContain('/tls-rpt/enable');

    // Sub-block timestamps NOT persisted (everything failed).
    const row = await readDomainFull(id);
    expect(row.mta_sts_verified_at).toBeNull();
    expect(row.tlsrpt_verified_at).toBeNull();
  });

  it('after explicit /mta-sts/enable → all MTA-STS checks pass + mta_sts_verified_at persisted', async () => {
    const stub = installVerifyFetchStub();
    const policyId = '20260515T130000Z';
    const id = await seedDomain({
      domain: 'after-enable.example.test',
      mtaStsMode: 'testing',
      mtaStsPolicyId: policyId,
    });
    // Wire DoH + HTTPS as if the operator already ran /mta-sts/enable.
    stub.doh.mx.set('after-enable.example.test', [
      '10 route1.mx.cloudflare.net.',
      '20 route2.mx.cloudflare.net.',
      '30 route3.mx.cloudflare.net.',
    ]);
    stub.doh.txt.set('_mta-sts.after-enable.example.test', [`"v=STSv1; id=${policyId}"`]);
    stub.pol.policy.set('mta-sts.after-enable.example.test', {
      status: 200,
      contentType: 'text/plain; charset=utf-8',
      body: `version: STSv1\nmode: testing\nmx: *.example.test\nmax_age: 86400\n`,
    });

    const out = await callVerify(id);

    // MTA-STS checks all pass — no operator-action hint emitted.
    expect(out.checks.find((c) => c.name.startsWith('mta-sts:operator-action:'))).toBeUndefined();
    const txtCheck = out.checks.find((c) => c.name === 'TXT _mta-sts id');
    expect(txtCheck?.ok).toBe(true);
    const httpsCheck = out.checks.find((c) => c.name === 'https mta-sts.txt status');
    expect(httpsCheck?.ok).toBe(true);

    // mta_sts_verified_at persisted.
    const row = await readDomainFull(id);
    expect(row.mta_sts_verified_at).not.toBeNull();
  });

  it('drift: bump policy_id mid-test, DoH still returns old id → drift detected + hint', async () => {
    const stub = installVerifyFetchStub();
    const oldId = '20260101T000000Z';
    const id = await seedDomain({
      domain: 'drift.example.test',
      mtaStsMode: 'testing',
      mtaStsPolicyId: oldId,
    });
    stub.doh.mx.set('drift.example.test', [
      '10 route1.mx.cloudflare.net.',
      '20 route2.mx.cloudflare.net.',
      '30 route3.mx.cloudflare.net.',
    ]);
    // DoH initially serves the OLD id (matches what was published earlier).
    stub.doh.txt.set('_mta-sts.drift.example.test', [`"v=STSv1; id=${oldId}"`]);
    stub.pol.policy.set('mta-sts.drift.example.test', {
      status: 200,
      contentType: 'text/plain',
      body: `version: STSv1\nmode: testing\nmx: *.example.test\nmax_age: 86400\n`,
    });

    // First verify — everything aligned. Should pass.
    const first = await callVerify(id);
    expect(
      first.checks.find((c) => c.name.startsWith('mta-sts:operator-action:')),
      'first verify should not emit hint (id matches)',
    ).toBeUndefined();
    const firstRow = await readDomainFull(id);
    expect(firstRow.mta_sts_verified_at).not.toBeNull();

    // Now bump the policy_id in D1 (simulating /promote) WITHOUT updating
    // the DoH TXT. Drift is now real.
    const newId = '20260601T000000Z';
    await testEnv.DB.prepare(`UPDATE mail_domains SET mta_sts_policy_id = ? WHERE id = ?`)
      .bind(newId, id)
      .run();

    const second = await callVerify(id);
    const hint = second.checks.find((c) => c.name.startsWith('mta-sts:operator-action:'));
    expect(hint, 'second verify should emit operator-action hint').toBeDefined();
    expect(hint!.expected).toContain(`policy_id=${newId}`);
    expect(hint!.actual).toContain('/mta-sts/enable');

    // The TXT id check failed because old != new.
    const txtCheck = second.checks.find((c) => c.name === 'TXT _mta-sts id');
    expect(txtCheck?.ok).toBe(false);
    expect(txtCheck?.expected).toBe(newId);
    expect(txtCheck?.actual).toContain(oldId);
  });

  it('mode=none → MTA-STS checks SKIPPED (no entries in response)', async () => {
    const stub = installVerifyFetchStub();
    const id = await seedDomain({
      domain: 'skip.example.test',
      mtaStsMode: 'none',
      tlsrptEnabled: false,
    });
    stub.doh.mx.set('skip.example.test', [
      '10 route1.mx.cloudflare.net.',
      '20 route2.mx.cloudflare.net.',
      '30 route3.mx.cloudflare.net.',
    ]);

    const out = await callVerify(id);

    // No MTA-STS checks at all.
    expect(out.checks.find((c) => c.name === 'TXT _mta-sts id')).toBeUndefined();
    expect(out.checks.find((c) => c.name.startsWith('mta-sts:'))).toBeUndefined();
    expect(out.checks.find((c) => c.name === 'TXT _smtp._tls rua')).toBeUndefined();
    expect(out.checks.find((c) => c.name.startsWith('tls-rpt:'))).toBeUndefined();
  });

  it('TLS-RPT sub-block: enable → verify → success persists tlsrpt_verified_at', async () => {
    const stub = installVerifyFetchStub();
    const rua = 'mailto:tlsrpt@test.local';
    const id = await seedDomain({
      domain: 'tls-rpt-ok.example.test',
      mtaStsMode: 'none',
      tlsrptEnabled: true,
      tlsrptRua: rua,
    });
    stub.doh.mx.set('tls-rpt-ok.example.test', [
      '10 route1.mx.cloudflare.net.',
      '20 route2.mx.cloudflare.net.',
      '30 route3.mx.cloudflare.net.',
    ]);
    stub.doh.txt.set('_smtp._tls.tls-rpt-ok.example.test', [`"v=TLSRPTv1; rua=${rua}"`]);

    const out = await callVerify(id);

    const ruaCheck = out.checks.find((c) => c.name === 'TXT _smtp._tls rua');
    expect(ruaCheck?.ok).toBe(true);
    expect(out.checks.find((c) => c.name.startsWith('tls-rpt:operator-action:'))).toBeUndefined();

    const row = await readDomainFull(id);
    expect(row.tlsrpt_verified_at).not.toBeNull();
  });

  it('partial success: TLS-RPT verifies but MTA-STS fails → tlsrpt_verified_at set, mta_sts_verified_at not', async () => {
    const stub = installVerifyFetchStub();
    const policyId = '20260601T120000Z';
    const rua = 'mailto:tlsrpt@test.local';
    const id = await seedDomain({
      domain: 'partial.example.test',
      mtaStsMode: 'testing',
      mtaStsPolicyId: policyId,
      tlsrptEnabled: true,
      tlsrptRua: rua,
    });
    stub.doh.mx.set('partial.example.test', [
      '10 route1.mx.cloudflare.net.',
      '20 route2.mx.cloudflare.net.',
      '30 route3.mx.cloudflare.net.',
    ]);
    // TLS-RPT TXT present; MTA-STS records absent.
    stub.doh.txt.set('_smtp._tls.partial.example.test', [`"v=TLSRPTv1; rua=${rua}"`]);

    await callVerify(id);

    const row = await readDomainFull(id);
    expect(row.tlsrpt_verified_at).not.toBeNull();
    expect(row.mta_sts_verified_at).toBeNull();
  });
});
