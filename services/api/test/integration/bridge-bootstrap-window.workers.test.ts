// Bridge bootstrap window — self-healing plaintext cache + installer-link
// teardown. Exercises the actual route handlers against Miniflare D1 + KV
// so we can assert (a) the heartbeat re-`put`s bridge_plain with a TTL
// that scales with tenure, and (b) the installer route 404s once the
// window is past / after the first heartbeat.
import { applyD1Migrations, createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { generateNonce, sign } from '@polaris-mail/hmac';
import { ulid } from '@polaris-mail/ids';
import worker from '../../src/index.js';
import type { Env } from '../../src/env.js';
import { bridgePlainKvKey, FLOOR_S, CEIL_S } from '../../src/bridge-auth.js';

interface TestEnv extends Env {
  DB: D1Database;
  KV_KEY_CACHE: KVNamespace;
}

const testEnv = env as unknown as TestEnv;

const POLARIS_SECRET = 'bootstrap-window-secret';
const ARGON2_PEPPER = 'bootstrap-window-pepper';
const DAY_MS = 24 * 60 * 60 * 1000;

let sharedAdmin = { admin_key_id: '', admin_key_secret: '' };

beforeAll(async () => {
  const migrations = inject('migrations');
  await applyD1Migrations(testEnv.DB, migrations);
  (testEnv as { POLARIS_SECRET_A?: string }).POLARIS_SECRET_A = POLARIS_SECRET;
  (testEnv as { ARGON2_PEPPER?: string }).ARGON2_PEPPER = ARGON2_PEPPER;
  (testEnv as { CF_API_TOKEN?: string }).CF_API_TOKEN = 'cf-token-test';
  (testEnv as { CF_ACCOUNT_ID?: string }).CF_ACCOUNT_ID = 'acct-test';
  (testEnv as { CF_ZONE_ID_MAIL_PLRS_IM?: string }).CF_ZONE_ID_MAIL_PLRS_IM = 'zone-mail-plrs';
  (testEnv as { ACME_EMAIL?: string }).ACME_EMAIL = 'ops@plrs.im';
  sharedAdmin = await runBootstrap();
});

beforeEach(async () => {
  await testEnv.DB.prepare(`DELETE FROM bridges`).run();
  installCfStub();
});

afterEach(() => {
  vi.restoreAllMocks();
});

let cfStubNextId = 1;
function installCfStub(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith('https://api.cloudflare.com/client/v4/')) {
      return (globalThis.fetch as unknown as { _isMockFunction?: boolean })._isMockFunction
        ? new Response('unstubbed', { status: 599 })
        : await (globalThis.fetch as typeof fetch)(input, init);
    }
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST' && url.endsWith('/user/tokens')) {
      const id = `cftok-${cfStubNextId++}`;
      return new Response(
        JSON.stringify({
          success: true,
          errors: [],
          messages: [],
          result: { id, value: `${id}-pt` },
        }),
      );
    }
    if (method === 'DELETE' && /\/user\/tokens\/[^/]+$/.test(url)) {
      return new Response(JSON.stringify({ success: true, errors: [], messages: [], result: {} }));
    }
    return new Response(`unhandled CF call ${method} ${url}`, { status: 502 });
  });
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
    { direction: 'polaris-api', method, path: u.pathname, query: u.search, ts, nonce, body },
    secret,
  );
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-polaris-ts': ts,
    'x-polaris-nonce': nonce,
    'x-polaris-sig': sig,
  };
  if (keyId) headers['x-polaris-key-id'] = keyId;
  return new Request(url, { method, headers, body: method === 'GET' ? undefined : body });
}

async function callWorker(req: Request): Promise<Response> {
  return worker.fetch(req, testEnv as unknown as Env, createExecutionContext());
}

async function runBootstrap(): Promise<{ admin_key_id: string; admin_key_secret: string }> {
  const res = await callWorker(
    await signedRequest('https://x/v1/admin/bootstrap', '{}', 'POST', POLARIS_SECRET, null),
  );
  if (res.status !== 200) throw new Error(`bootstrap failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { admin_key_id: string; admin_key_secret: string };
}

async function registerBridge(name: string): Promise<{ id: string; hmac_key: string }> {
  const res = await callWorker(
    await signedRequest(
      'https://x/v1/admin/bridges',
      JSON.stringify({ name }),
      'POST',
      sharedAdmin.admin_key_secret,
      sharedAdmin.admin_key_id,
    ),
  );
  if (res.status !== 201)
    throw new Error(`registerBridge failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { id: string; hmac_key: string };
}

async function heartbeat(bridgeId: string, hmacKey: string): Promise<Response> {
  const url = 'https://x/v1/bridge/heartbeat';
  const u = new URL(url);
  const body = JSON.stringify({
    schema_version: 2,
    bridge_version: '0.1.0-test',
    uptime_seconds: 300,
    reported_at: new Date().toISOString(),
    node: { hostname: 'h', os: 'linux', arch: 'amd64', container_id: null, tailnet_node_id: null },
    services: {
      smtp: { listening: true, port: 465, sessions_active: 0, errors_24h: 0 },
      imap: { listening: true, port: 993, sessions_active: 0, errors_24h: 0 },
      webhook_receiver: { deliveries_24h: 0, errors_24h: 0 },
    },
    acme: {
      fqdn: 't.mail.plrs.im',
      cert_not_after: null,
      last_renew_attempt_at: null,
      last_renew_status: null,
    },
    mirror: { message_count: 0, lag_seconds: 0, last_sync_at: null },
    recent_errors: [],
    settings_version: 0,
    directive_acks: [],
    logs: [],
    last_log_seq: 0,
  });
  const ts = String(Date.now());
  const nonce = generateNonce();
  const sig = await sign(
    {
      direction: 'polaris-api',
      method: 'POST',
      path: u.pathname,
      query: u.search,
      ts,
      nonce,
      body,
    },
    hmacKey,
  );
  return callWorker(
    new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-polaris-bridge-id': bridgeId,
        'x-polaris-submission-id': ulid(),
        'x-polaris-ts': ts,
        'x-polaris-nonce': nonce,
        'x-polaris-sig': sig,
      },
      body,
    }),
  );
}

/** Capture the expirationTtl the heartbeat used to refresh bridge_plain. */
function spyPlainPutTtl(bridgeId: string): { ttl: () => number | undefined } {
  const key = bridgePlainKvKey(bridgeId);
  let captured: number | undefined;
  const orig = testEnv.KV_KEY_CACHE.put.bind(testEnv.KV_KEY_CACHE);
  vi.spyOn(testEnv.KV_KEY_CACHE, 'put').mockImplementation(async (k, v, opts) => {
    if (k === key && opts && 'expirationTtl' in opts) captured = opts.expirationTtl as number;
    return orig(k, v as string, opts as KVNamespacePutOptions);
  });
  return { ttl: () => captured };
}

describe('bridge bootstrap window', () => {
  it('register opens an ~8h installer window and seeds bridge_plain at the floor', async () => {
    const b = await registerBridge('win-register');
    const row = await testEnv.DB.prepare(
      `SELECT installer_window_expires_at, first_heartbeat_at, availability_ewma FROM bridges WHERE id = ?`,
    )
      .bind(b.id)
      .first<{
        installer_window_expires_at: string | null;
        first_heartbeat_at: string | null;
        availability_ewma: number | null;
      }>();
    expect(row?.installer_window_expires_at).toBeTruthy();
    const remainingMs = Date.parse(row!.installer_window_expires_at!) - Date.now();
    expect(remainingMs).toBeGreaterThan(7 * 60 * 60 * 1000);
    expect(remainingMs).toBeLessThanOrEqual(8 * 60 * 60 * 1000 + 5000);
    // Pre-heartbeat: no tenure/availability yet.
    expect(row?.first_heartbeat_at).toBeNull();
    expect(row?.availability_ewma).toBeNull();
  });

  it('installer route serves inside the window then 404s once it is past', async () => {
    const b = await registerBridge('win-installer');
    const installRes = await callWorker(
      new Request(`https://x/v1/installer/bridge/${b.id}/${b.hmac_key}`),
    );
    expect(installRes.status).toBe(200);
    expect(installRes.headers.get('content-type')).toContain('x-shellscript');

    // Force the window into the past — the URL is still HMAC-valid.
    await testEnv.DB.prepare(`UPDATE bridges SET installer_window_expires_at = ? WHERE id = ?`)
      .bind(new Date(Date.now() - 1000).toISOString(), b.id)
      .run();
    const expiredRes = await callWorker(
      new Request(`https://x/v1/installer/bridge/${b.id}/${b.hmac_key}`),
    );
    expect(expiredRes.status).toBe(404);
  });

  it('first heartbeat closes the installer window and sets the tenure anchor', async () => {
    const b = await registerBridge('win-firstbeat');
    const hb = await heartbeat(b.id, b.hmac_key);
    expect(hb.status).toBe(200);

    const row = await testEnv.DB.prepare(
      `SELECT installer_window_expires_at, first_heartbeat_at, availability_ewma FROM bridges WHERE id = ?`,
    )
      .bind(b.id)
      .first<{
        installer_window_expires_at: string;
        first_heartbeat_at: string;
        availability_ewma: number;
      }>();
    // Window pulled back to ~now (closed), tenure anchor + EWMA initialised.
    expect(Date.parse(row!.installer_window_expires_at)).toBeLessThanOrEqual(Date.now() + 2000);
    expect(row!.first_heartbeat_at).toBeTruthy();
    expect(row!.availability_ewma).toBe(1.0);

    const after = await callWorker(
      new Request(`https://x/v1/installer/bridge/${b.id}/${b.hmac_key}`),
    );
    expect(after.status).toBe(404);
  });

  it('a fresh bridge refreshes bridge_plain at the floor TTL', async () => {
    const b = await registerBridge('win-floorttl');
    const spy = spyPlainPutTtl(b.id);
    const hb = await heartbeat(b.id, b.hmac_key);
    expect(hb.status).toBe(200);
    // First heartbeat ⇒ tenure ≈ 0 ⇒ floor.
    expect(spy.ttl()).toBe(FLOOR_S);
  });

  it('a tenured, reliable bridge refreshes bridge_plain near the ceiling TTL', async () => {
    const b = await registerBridge('win-ceilttl');
    // Simulate ~30d of tenure at full availability with a recent prior beat.
    const farPast = new Date(Date.now() - 31 * DAY_MS).toISOString();
    const recent = new Date(Date.now() - 60_000).toISOString();
    await testEnv.DB.prepare(
      `UPDATE bridges SET first_heartbeat_at = ?, last_heartbeat_at = ?, availability_ewma = 1.0 WHERE id = ?`,
    )
      .bind(farPast, recent, b.id)
      .run();
    const spy = spyPlainPutTtl(b.id);
    const hb = await heartbeat(b.id, b.hmac_key);
    expect(hb.status).toBe(200);
    expect(spy.ttl()).toBe(CEIL_S);
  });
});
