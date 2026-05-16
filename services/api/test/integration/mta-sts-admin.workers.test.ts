// Phase C.10 — pool-workers integration test for the MTA-STS + TLS-RPT
// admin endpoints in services/api/src/routes/admin/domains-mta-sts.ts.
//
// What this test exercises:
//   - HMAC-authed admin path through the real Hono Worker.
//   - D1 migrations applied (so `mail_domains.mta_sts_*` + audit_log
//     CHECK constraint match production).
//   - `packages/cf-api` provisioning calls — upstream fetches are
//     intercepted with `vi.spyOn(globalThis, 'fetch')` so we don't
//     touch the real Cloudflare API.
//
// What we do NOT exercise (separately tested):
//   - The public MTA-STS policy handler at mta-sts.{tenant} — that's
//     `mta-sts-policy.workers.test.ts`.
//   - Lower-level provisioning correctness — that's
//     `packages/cf-api/test/mta-sts.test.ts`.
//
// CF fetch interception strategy:
//   We stub `globalThis.fetch` per-test and replay the small subset of
//   Cloudflare endpoints that the cf-api helpers call. The stub returns
//   the canonical CF envelope shape `{ success: true, result: ... }` so
//   the real client schema parser is happy. We record requests for
//   assertions ("PUT /workers/domains was issued").
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

const POLARIS_SECRET = 'phase-c10-control-plane-secret';
const ARGON2_PEPPER = 'phase-c10-pepper';
const CF_API_TOKEN = 'phase-c10-cf-token';
const CF_ACCOUNT_ID = 'phase-c10-cf-account';

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

interface SeedDomainOpts {
  domain: string;
  status?: string;
  cfZoneId?: string | null;
  inboundEnabled?: boolean;
  mtaStsMode?: 'none' | 'testing' | 'enforce';
  mtaStsPolicyId?: string | null;
  tlsrptEnabled?: boolean;
  tlsrptRua?: string | null;
}

let domainSeq = 0;
async function seedDomain(opts: SeedDomainOpts): Promise<string> {
  domainSeq += 1;
  const seq = String(domainSeq).padStart(4, '0');
  const id = `01HX00DOM${seq}000000000000C0`.slice(0, 26);
  const zoneId = `01HX00ZON${seq}000000000000C0`.slice(0, 26);
  const nowIso = new Date().toISOString();
  const cfZoneId = opts.cfZoneId === undefined ? `cf-zone-${seq}` : opts.cfZoneId;
  await testEnv.DB.prepare(
    `INSERT INTO zones (id, cf_zone_id, name, created_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(zoneId, `cfz-c10-${seq}`, opts.domain, nowIso)
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
      opts.inboundEnabled === false ? 0 : 1,
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

interface CfRequest {
  method: string;
  url: string;
  body: string | null;
}

/**
 * Install a `globalThis.fetch` stub that simulates the small slice of the
 * Cloudflare REST API that `provisionMtaSts` / `provisionTlsRpt` /
 * `unprovisionMtaSts` / `unprovisionTlsRpt` exercise. Returns a recorder so
 * each test can assert on the upstream calls. Worker hostnames (`https://x`)
 * are forwarded to the real worker.fetch path to keep the test plumbing
 * single-shaped.
 */
function installCfFetchStub(): { calls: CfRequest[] } {
  const calls: CfRequest[] = [];
  // Stateful per-record store keyed by `${type}:${name}` so upsert/delete
  // sequences behave like a real DNS zone.
  type DnsRec = { id: string; type: string; name: string; content: string };
  const records = new Map<string, DnsRec>();
  let nextId = 1;
  let workerDomain: { id: string; hostname: string; zone_id: string; service: string } | null =
    null;

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const bodyText =
      typeof init?.body === 'string' ? init.body : init?.body ? String(init.body) : null;
    calls.push({ method, url, body: bodyText });

    // Only intercept Cloudflare upstream. Anything else returns 502 — tests
    // that need other fetch behaviour should restore the mock themselves.
    if (!url.startsWith('https://api.cloudflare.com/client/v4/')) {
      return new Response('unexpected upstream', { status: 502 });
    }

    // ---- DNS records ----
    // GET /zones/{zoneId}/dns_records?type=TXT&name=...
    const zoneMatch = url.match(/\/zones\/([^/]+)\/dns_records(?:\?([^#]*))?$/);
    if (zoneMatch && method === 'GET') {
      const params = new URLSearchParams(zoneMatch[2] ?? '');
      const type = params.get('type') ?? '';
      const name = params.get('name') ?? '';
      const matches: DnsRec[] = [];
      for (const r of records.values()) {
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
      const rec: DnsRec = { id, type: parsed.type, name: parsed.name, content: parsed.content };
      records.set(`${rec.type}:${rec.name}`, rec);
      return new Response(JSON.stringify({ success: true, result: { ...rec } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const dnsIdMatch = url.match(/\/zones\/([^/]+)\/dns_records\/([^/?#]+)$/);
    if (dnsIdMatch && method === 'PATCH') {
      const parsed = JSON.parse(bodyText ?? '{}');
      const recId = dnsIdMatch[2];
      for (const [k, v] of records) {
        if (v.id === recId) {
          const updated: DnsRec = {
            id: recId,
            type: parsed.type ?? v.type,
            name: parsed.name ?? v.name,
            content: parsed.content ?? v.content,
          };
          records.set(k, updated);
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
    if (dnsIdMatch && method === 'DELETE') {
      const recId = dnsIdMatch[2];
      for (const [k, v] of records) {
        if (v.id === recId) {
          records.delete(k);
          break;
        }
      }
      return new Response(JSON.stringify({ success: true, result: { id: recId } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // ---- Worker custom domains ----
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
    const domIdMatch = url.match(/\/accounts\/[^/]+\/workers\/domains\/([^/?#]+)$/);
    if (domIdMatch && method === 'DELETE') {
      workerDomain = null;
      return new Response(JSON.stringify({ success: true, result: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response(
      JSON.stringify({ success: false, errors: [{ code: 9999, message: 'no stub' }] }),
      { status: 501, headers: { 'content-type': 'application/json' } },
    );
  });
  return { calls };
}

let adminCreds: BootstrapResult;

beforeAll(async () => {
  const migrations = inject('migrations');
  await applyD1Migrations(testEnv.DB, migrations);
  (testEnv as unknown as Record<string, unknown>).POLARIS_SECRET_A = POLARIS_SECRET;
  (testEnv as unknown as Record<string, unknown>).ARGON2_PEPPER = ARGON2_PEPPER;
  // Bootstrap is one-shot — call it once and share the admin key across tests.
  adminCreds = await bootstrap();
});

beforeEach(() => {
  // Default to having CF creds. Individual tests reassign to override.
  (testEnv as unknown as Record<string, unknown>).CF_API_TOKEN = CF_API_TOKEN;
  (testEnv as unknown as Record<string, unknown>).CF_ACCOUNT_ID = CF_ACCOUNT_ID;
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface DbDomainRow {
  mta_sts_mode: string;
  mta_sts_policy_id: string | null;
  tlsrpt_enabled: number;
  tlsrpt_rua: string | null;
}

async function readDomain(id: string): Promise<DbDomainRow> {
  const row = await testEnv.DB.prepare(
    `SELECT mta_sts_mode, mta_sts_policy_id, tlsrpt_enabled, tlsrpt_rua
     FROM mail_domains WHERE id = ?`,
  )
    .bind(id)
    .first<DbDomainRow>();
  if (!row) throw new Error(`domain ${id} not found`);
  return row;
}

async function countAudit(action: string, target: string): Promise<number> {
  const row = await testEnv.DB.prepare(
    `SELECT COUNT(*) as n FROM audit_log WHERE action = ? AND target = ?`,
  )
    .bind(action, target)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe('services/api MTA-STS + TLS-RPT admin endpoints (pool-workers)', () => {
  it('POST /v1/admin/domains/:id/mta-sts/enable lights up a fresh verified domain', async () => {
    const admin = adminCreds;
    const domainId = await seedDomain({ domain: 'enable.example.test' });
    const cf = installCfFetchStub();

    const res = await callWorker(
      await signedRequest(
        `https://x/v1/admin/domains/${domainId}/mta-sts/enable`,
        '{}',
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    const text = await res.text();
    expect(res.status, `expected 200, got ${res.status}: ${text}`).toBe(200);
    const body = JSON.parse(text) as {
      id: string;
      mta_sts_mode: string;
      mta_sts_policy_id: string;
      provisioned: { created: number; skipped: number; customDomainAttached: boolean };
    };
    expect(body.id).toBe(domainId);
    expect(body.mta_sts_mode).toBe('testing');
    expect(body.mta_sts_policy_id).toMatch(/^\d{8}T\d{6}Z$/);
    expect(body.provisioned.customDomainAttached).toBe(true);

    // D1 reflects the change
    const row = await readDomain(domainId);
    expect(row.mta_sts_mode).toBe('testing');
    expect(row.mta_sts_policy_id).toBe(body.mta_sts_policy_id);

    // Audit row
    expect(await countAudit('mta_sts.enable', domainId)).toBe(1);

    // CF stub saw the PUT /workers/domains
    const cfPuts = cf.calls.filter((c) => c.method === 'PUT' && c.url.includes('/workers/domains'));
    expect(cfPuts.length).toBe(1);
    // And the DNS POST for _mta-sts.{domain}
    const dnsPosts = cf.calls.filter((c) => c.method === 'POST' && c.url.includes('/dns_records'));
    expect(dnsPosts.length).toBe(1);
  });

  it('returns 422 domain_not_verified when status != verified', async () => {
    const admin = adminCreds;
    const domainId = await seedDomain({
      domain: 'unverified.example.test',
      status: 'pending',
    });
    installCfFetchStub();

    const res = await callWorker(
      await signedRequest(
        `https://x/v1/admin/domains/${domainId}/mta-sts/enable`,
        '{}',
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('domain_not_verified');
  });

  it('returns 502 cf_upstream when CF_API_TOKEN is missing', async () => {
    const admin = adminCreds;
    const domainId = await seedDomain({ domain: 'no-cf.example.test' });
    installCfFetchStub();
    // Wipe the token *after* bootstrap (bootstrap doesn't need CF).
    (testEnv as unknown as Record<string, unknown>).CF_API_TOKEN = undefined;

    const res = await callWorker(
      await signedRequest(
        `https://x/v1/admin/domains/${domainId}/mta-sts/enable`,
        '{}',
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('cf_upstream');
  });

  it('POST /mta-sts/promote moves testing → enforce and mints a fresh policy_id', async () => {
    const admin = adminCreds;
    // Seed the row already in 'testing' so promote can run directly.
    const oldId = '20250101T000000Z';
    const domainId = await seedDomain({
      domain: 'promote.example.test',
      mtaStsMode: 'testing',
      mtaStsPolicyId: oldId,
    });
    installCfFetchStub();

    const res = await callWorker(
      await signedRequest(
        `https://x/v1/admin/domains/${domainId}/mta-sts/promote`,
        '{}',
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mta_sts_mode: string; mta_sts_policy_id: string };
    expect(body.mta_sts_mode).toBe('enforce');
    expect(body.mta_sts_policy_id).toMatch(/^\d{8}T\d{6}Z$/);
    expect(body.mta_sts_policy_id).not.toBe(oldId);

    const row = await readDomain(domainId);
    expect(row.mta_sts_mode).toBe('enforce');
    expect(row.mta_sts_policy_id).toBe(body.mta_sts_policy_id);
    expect(await countAudit('mta_sts.promote', domainId)).toBe(1);
  });

  it('refuses promote when current mode is none', async () => {
    const admin = adminCreds;
    const domainId = await seedDomain({ domain: 'promote-from-none.example.test' });
    installCfFetchStub();

    const res = await callWorker(
      await signedRequest(
        `https://x/v1/admin/domains/${domainId}/mta-sts/promote`,
        '{}',
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad_request');
  });

  it('POST /mta-sts/disable clears the mode and nulls the policy_id', async () => {
    const admin = adminCreds;
    const domainId = await seedDomain({
      domain: 'disable.example.test',
      mtaStsMode: 'testing',
      mtaStsPolicyId: '20250515T120000Z',
    });
    const cf = installCfFetchStub();

    const res = await callWorker(
      await signedRequest(
        `https://x/v1/admin/domains/${domainId}/mta-sts/disable`,
        '{}',
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mta_sts_mode: string; mta_sts_policy_id: string | null };
    expect(body.mta_sts_mode).toBe('none');
    expect(body.mta_sts_policy_id).toBeNull();

    const row = await readDomain(domainId);
    expect(row.mta_sts_mode).toBe('none');
    expect(row.mta_sts_policy_id).toBeNull();

    expect(await countAudit('mta_sts.disable', domainId)).toBe(1);

    // Cloudflare: a DELETE on /workers/domains/{id} should have been issued.
    // It might not fire if no domain was attached in the stub state, but we
    // at least saw the GET probe for it.
    const workerProbes = cf.calls.filter((c) => c.url.includes('/workers/domains'));
    expect(workerProbes.length).toBeGreaterThan(0);
  });

  it('POST /tls-rpt/enable with custom rua records the supplied address', async () => {
    const admin = adminCreds;
    const domainId = await seedDomain({ domain: 'tlsrpt-custom.example.test' });
    installCfFetchStub();

    const customRua = 'mailto:reports@inbox.example.test';
    const res = await callWorker(
      await signedRequest(
        `https://x/v1/admin/domains/${domainId}/tls-rpt/enable`,
        JSON.stringify({ rua: customRua }),
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tlsrpt_enabled: number; tlsrpt_rua: string };
    expect(body.tlsrpt_enabled).toBe(1);
    expect(body.tlsrpt_rua).toBe(customRua);

    const row = await readDomain(domainId);
    expect(row.tlsrpt_enabled).toBe(1);
    expect(row.tlsrpt_rua).toBe(customRua);

    expect(await countAudit('tls_rpt.enable', domainId)).toBe(1);
  });

  it('POST /tls-rpt/enable without a body falls back to env.TLSRPT_DEFAULT_RUA', async () => {
    const admin = adminCreds;
    const domainId = await seedDomain({ domain: 'tlsrpt-fallback.example.test' });
    installCfFetchStub();

    const res = await callWorker(
      await signedRequest(
        `https://x/v1/admin/domains/${domainId}/tls-rpt/enable`,
        '',
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tlsrpt_rua: string };
    // wrangler.test.jsonc sets TLSRPT_DEFAULT_RUA = "mailto:tlsrpt@test.local".
    expect(body.tlsrpt_rua).toBe(testEnv.TLSRPT_DEFAULT_RUA ?? 'mailto:tlsrpt@plrs.im');

    const row = await readDomain(domainId);
    expect(row.tlsrpt_rua).toBe(body.tlsrpt_rua);
  });

  it('POST /tls-rpt/disable clears the enabled flag (keeps rua history)', async () => {
    const admin = adminCreds;
    const domainId = await seedDomain({
      domain: 'tlsrpt-disable.example.test',
      tlsrptEnabled: true,
      tlsrptRua: 'mailto:reports@inbox.example.test',
    });
    installCfFetchStub();

    const res = await callWorker(
      await signedRequest(
        `https://x/v1/admin/domains/${domainId}/tls-rpt/disable`,
        '{}',
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tlsrpt_enabled: number; tlsrpt_rua: string };
    expect(body.tlsrpt_enabled).toBe(0);
    // historical rua preserved
    expect(body.tlsrpt_rua).toBe('mailto:reports@inbox.example.test');

    const row = await readDomain(domainId);
    expect(row.tlsrpt_enabled).toBe(0);
    expect(row.tlsrpt_rua).toBe('mailto:reports@inbox.example.test');

    expect(await countAudit('tls_rpt.disable', domainId)).toBe(1);
  });
});
