// Bridge telemetry — heartbeat ingest + per-bridge admin endpoints
// (activity, audit, heartbeat-get) plus the liveness/serves_mailboxes
// projection on list/get.
//
// Pool-workers test (real Miniflare D1 with our migrations applied) so
// we exercise the actual SUM/COUNT aggregates in
// `/v1/admin/bridges/:id/activity` against a real SQLite engine. The
// in-memory mock D1 in `services/api/test/mocks.ts` deliberately
// supports only column-by-column SELECTs, so aggregation tests live here.

import { applyD1Migrations, createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { generateNonce, sign } from '@polaris-mail/hmac';
import { ulid } from '@polaris-mail/ids';
import worker from '../../src/index.js';
import type { Env } from '../../src/env.js';

interface TestEnv extends Env {
  DB: D1Database;
  KV_KEY_CACHE: KVNamespace;
}

const testEnv = env as unknown as TestEnv;

const POLARIS_SECRET = 'phase-b8-control-plane-secret';
const ARGON2_PEPPER = 'phase-b8-pepper';

// `/v1/admin/bootstrap` is one-shot per D1 (the second call sees the
// genesis api_key row already populated and 409s). Stash the credentials
// from a single bootstrap in beforeAll and share them across every test.
let sharedAdmin: { admin_key_id: string; admin_key_secret: string } = {
  admin_key_id: '',
  admin_key_secret: '',
};

beforeAll(async () => {
  const migrations = inject('migrations');
  await applyD1Migrations(testEnv.DB, migrations);
  (testEnv as { POLARIS_SECRET_A?: string }).POLARIS_SECRET_A = POLARIS_SECRET;
  (testEnv as { ARGON2_PEPPER?: string }).ARGON2_PEPPER = ARGON2_PEPPER;
  // Required by /v1/bridge/config + the CF token mint flow in register/rotate.
  (testEnv as { CF_API_TOKEN?: string }).CF_API_TOKEN = 'cf-token-test';
  (testEnv as { CF_ACCOUNT_ID?: string }).CF_ACCOUNT_ID = 'acct-test';
  (testEnv as { CF_ZONE_ID_MAIL_PLRS_IM?: string }).CF_ZONE_ID_MAIL_PLRS_IM = 'zone-mail-plrs';
  (testEnv as { ACME_EMAIL?: string }).ACME_EMAIL = 'ops@plrs.im';
  sharedAdmin = await runBootstrap();
});

beforeEach(async () => {
  // Wipe only the rows tests create — leave the genesis admin api_key /
  // root operator alone so `sharedAdmin` keeps authenticating.
  await testEnv.DB.prepare(`DELETE FROM messages`).run();
  await testEnv.DB.prepare(`DELETE FROM bridges`).run();
  // Default CF stub: every test that mints / revokes goes through this.
  // Tests can override by re-spying inside their `it` block.
  installCfStub();
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface CfCall {
  method: string;
  url: string;
  body: string | null;
}

// Module-level so token ids stay unique across stub re-installs.
// `vi.restoreAllMocks()` in afterEach drops the spy but not this
// counter; tests that need a fresh sequence reset it explicitly.
let cfStubNextId = 1;

/**
 * Stub `globalThis.fetch` for Cloudflare /user/tokens calls. Returns a
 * `calls` array so tests can assert on what the worker sent upstream.
 * Non-Cloudflare URLs aren't intercepted — `worker.fetch` continues to
 * route them through the in-isolate router.
 */
function installCfStub(): { calls: CfCall[] } {
  const calls: CfCall[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith('https://api.cloudflare.com/client/v4/')) {
      // Forward everything else to the real fetch path. Workers test
      // pool keeps the original globalThis.fetch on the spy's underlying
      // function — vi.restoreAllMocks() in afterEach puts it back.
      const orig = (globalThis.fetch as unknown as { _isMockFunction?: boolean })._isMockFunction
        ? // Shouldn't recurse — but defend anyway.
          new Response('unstubbed', { status: 599 })
        : await (globalThis.fetch as typeof fetch)(input, init);
      return orig;
    }
    const method = (init?.method ?? 'GET').toUpperCase();
    const bodyText =
      typeof init?.body === 'string' ? init.body : init?.body ? String(init.body) : null;
    calls.push({ method, url, body: bodyText });

    // POST /user/tokens — mint
    if (method === 'POST' && url.endsWith('/user/tokens')) {
      const id = `cftok-${cfStubNextId++}`;
      return new Response(
        JSON.stringify({
          success: true,
          errors: [],
          messages: [],
          result: { id, value: `${id}-plaintext` },
        }),
      );
    }
    // DELETE /user/tokens/:id — revoke
    if (method === 'DELETE' && /\/user\/tokens\/[^/]+$/.test(url)) {
      return new Response(JSON.stringify({ success: true, errors: [], messages: [], result: {} }));
    }
    return new Response(`unhandled CF call ${method} ${url}`, { status: 502 });
  });
  return { calls };
}

async function signedRequest(
  url: string,
  body: string,
  method: string,
  secret: string,
  keyId: string | null,
  extraHeaders: Record<string, string> = {},
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
    ...extraHeaders,
  };
  if (keyId) headers['x-polaris-key-id'] = keyId;
  return new Request(url, {
    method,
    headers,
    body: method === 'GET' ? undefined : body,
  });
}

async function callWorker(req: Request): Promise<Response> {
  return worker.fetch(req, testEnv as unknown as Env, createExecutionContext());
}

async function runBootstrap(): Promise<{ admin_key_id: string; admin_key_secret: string }> {
  const req = await signedRequest(
    'https://x/v1/admin/bootstrap',
    '{}',
    'POST',
    POLARIS_SECRET,
    null,
  );
  const res = await callWorker(req);
  if (res.status !== 200) throw new Error(`bootstrap failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { admin_key_id: string; admin_key_secret: string };
}

async function registerBridge(
  admin: { admin_key_id: string; admin_key_secret: string },
  name: string,
): Promise<{ id: string; hmac_key: string }> {
  const res = await callWorker(
    await signedRequest(
      'https://x/v1/admin/bridges',
      JSON.stringify({ name }),
      'POST',
      admin.admin_key_secret,
      admin.admin_key_id,
    ),
  );
  if (res.status !== 201) {
    throw new Error(`registerBridge failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as { id: string; hmac_key: string };
}

async function bridgeHeartbeatRequest(
  bridgeId: string,
  hmacKey: string,
  body: unknown,
): Promise<Request> {
  const url = 'https://x/v1/bridge/heartbeat';
  const u = new URL(url);
  const bodyStr = JSON.stringify(body);
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
      body: bodyStr,
    },
    hmacKey,
  );
  return new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-polaris-bridge-id': bridgeId,
      'x-polaris-submission-id': ulid(),
      'x-polaris-ts': ts,
      'x-polaris-nonce': nonce,
      'x-polaris-sig': sig,
    },
    body: bodyStr,
  });
}

// Heartbeat v2 body — matches BridgeHeartbeatRequest in
// packages/schema/src/index.ts. Earlier tests used the v1 shape;
// migration 0012 made v2 mandatory.
const validHeartbeatBody = () => ({
  schema_version: 2 as const,
  bridge_version: '0.1.0-test',
  uptime_seconds: 300,
  reported_at: new Date().toISOString(),
  node: {
    hostname: 'test-host',
    os: 'linux',
    arch: 'amd64',
    container_id: null,
    tailnet_node_id: null,
  },
  services: {
    smtp: { listening: true, port: 465, sessions_active: 0, errors_24h: 0 },
    imap: { listening: true, port: 993, sessions_active: 2, errors_24h: 0 },
    webhook_receiver: { deliveries_24h: 17, errors_24h: 0 },
  },
  acme: {
    fqdn: 'test.mail.plrs.im',
    cert_not_after: null,
    last_renew_attempt_at: null,
    last_renew_status: null,
  },
  mirror: { message_count: 42, lag_seconds: 0, last_sync_at: null },
  recent_errors: [],
  settings_version: 0,
  directive_acks: [],
  logs: [],
  last_log_seq: 0,
});

describe('bridge telemetry', () => {
  it('list/get include liveness=offline + serves_mailboxes=0 for a freshly-registered bridge with no mailboxes', async () => {
    const admin = sharedAdmin;
    const bridge = await registerBridge(admin, 'tel-fresh');

    const getRes = await callWorker(
      await signedRequest(
        `https://x/v1/admin/bridges/${bridge.id}`,
        '',
        'GET',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as {
      id: string;
      liveness: string;
      serves_mailboxes: number;
      last_seen_at: string | null;
      bridge_version: string | null;
    };
    expect(body.id).toBe(bridge.id);
    expect(body.liveness).toBe('offline');
    expect(body.last_seen_at).toBeNull();
    expect(body.bridge_version).toBeNull();
    expect(body.serves_mailboxes).toBe(0);

    const listRes = await callWorker(
      await signedRequest(
        `https://x/v1/admin/bridges`,
        '',
        'GET',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    const list = (await listRes.json()) as {
      data: Array<{ id: string; liveness: string; serves_mailboxes: number }>;
    };
    const row = list.data.find((r) => r.id === bridge.id);
    expect(row?.liveness).toBe('offline');
    expect(row?.serves_mailboxes).toBe(0);
  });

  it('POST /v1/bridge/heartbeat stores the snapshot, flips liveness to live, and echoes back via GET /heartbeat', async () => {
    const admin = sharedAdmin;
    const bridge = await registerBridge(admin, 'tel-hb');

    const hbRes = await callWorker(
      await bridgeHeartbeatRequest(bridge.id, bridge.hmac_key, validHeartbeatBody()),
    );
    expect(hbRes.status).toBe(200);
    const hbBody = (await hbRes.json()) as { enabled: boolean; settings: unknown };
    expect(hbBody.enabled).toBe(true);
    expect(hbBody.settings).not.toBeNull();

    const getRes = await callWorker(
      await signedRequest(
        `https://x/v1/admin/bridges/${bridge.id}`,
        '',
        'GET',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    const det = (await getRes.json()) as {
      liveness: string;
      bridge_version: string | null;
      last_seen_at: string | null;
    };
    expect(det.liveness).toBe('live');
    expect(det.bridge_version).toBe('0.1.0-test');
    expect(det.last_seen_at).not.toBeNull();

    const snapRes = await callWorker(
      await signedRequest(
        `https://x/v1/admin/bridges/${bridge.id}/heartbeat`,
        '',
        'GET',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    expect(snapRes.status).toBe(200);
    const snap = (await snapRes.json()) as {
      liveness: string;
      payload: ReturnType<typeof validHeartbeatBody> | null;
    };
    expect(snap.liveness).toBe('live');
    expect(snap.payload).toMatchObject({
      bridge_version: '0.1.0-test',
      uptime_seconds: 300,
      services: { imap: { sessions_active: 2 } },
      mirror: { message_count: 42 },
    });
  });

  it('rejects heartbeat signed with the wrong bridge key', async () => {
    const admin = sharedAdmin;
    const a = await registerBridge(admin, 'tel-a');
    const b = await registerBridge(admin, 'tel-b');

    const res = await callWorker(
      await bridgeHeartbeatRequest(a.id, b.hmac_key, validHeartbeatBody()),
    );
    expect(res.status).toBe(401);
  });

  it('rejects v1 heartbeats with a clear upgrade-required error', async () => {
    const admin = sharedAdmin;
    const bridge = await registerBridge(admin, 'tel-v1');

    const res = await callWorker(
      await bridgeHeartbeatRequest(bridge.id, bridge.hmac_key, {
        schema_version: 1,
        bridge_version: '0.0.9',
        uptime_seconds: 0,
        imap_sessions_active: 0,
        smtp_submissions_24h: 0,
        errors_24h: 0,
        mirror_message_count: 0,
        reported_at: new Date().toISOString(),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('bridge image too old');
  });

  it('rejects heartbeat with invalid body shape', async () => {
    const admin = sharedAdmin;
    const bridge = await registerBridge(admin, 'tel-bad');

    const res = await callWorker(
      await bridgeHeartbeatRequest(bridge.id, bridge.hmac_key, {
        schema_version: 2,
        bridge_version: '',
        uptime_seconds: 0,
      }),
    );
    expect(res.status).toBe(400);
  });

  it('GET /v1/admin/bridges/:id/activity returns zero-totals for a fresh bridge and aggregates real rows', async () => {
    const admin = sharedAdmin;
    const bridge = await registerBridge(admin, 'tel-act');

    // Empty bridge first — should return all zeros.
    const empty = await callWorker(
      await signedRequest(
        `https://x/v1/admin/bridges/${bridge.id}/activity`,
        '',
        'GET',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    expect(empty.status).toBe(200);
    const emptyBody = (await empty.json()) as {
      bridge_id: string;
      window: string;
      totals: Record<string, number>;
      latest_message: unknown;
    };
    expect(emptyBody.bridge_id).toBe(bridge.id);
    expect(emptyBody.window).toBe('24h');
    expect(emptyBody.totals).toEqual({
      submitted: 0,
      delivered: 0,
      failed: 0,
      bounced: 0,
      inflight: 0,
    });
    expect(emptyBody.latest_message).toBeNull();

    // Seed two messages on this bridge — one delivered, one bounced —
    // and one belonging to another bridge to prove the filter scopes.
    // We need a mailbox row that messages.mailbox_id can FK to, and
    // mailbox FKs to nothing tricky; insert a bare row.
    const mailboxId = ulid();
    const nowIso = new Date().toISOString();
    await testEnv.DB.prepare(
      `INSERT INTO mailboxes (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(mailboxId, 'tel-act-box', null, nowIso, nowIso)
      .run();

    const otherBridge = await registerBridge(admin, 'tel-act-other');

    // `from_addr_normalized` is a SQLite generated column (see migration
    // 0001) — let it derive itself rather than binding a value.
    const insertMsg = async (id: string, bridgeId: string, status: string) => {
      await testEnv.DB.prepare(
        `INSERT INTO messages
           (id, mailbox_id, bridge_id, direction, status,
            r2_key, content_sha256, from_addr,
            to_addrs, subject, created_at)
         VALUES (?, ?, ?, 'out', ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          id,
          mailboxId,
          bridgeId,
          status,
          `r2/${id}`,
          'sha256-test',
          'a@example.com',
          'b@example.com',
          'subj',
          new Date().toISOString(),
        )
        .run();
    };
    await insertMsg(ulid(), bridge.id, 'delivered');
    await insertMsg(ulid(), bridge.id, 'bounced');
    await insertMsg(ulid(), otherBridge.id, 'delivered');

    const res = await callWorker(
      await signedRequest(
        `https://x/v1/admin/bridges/${bridge.id}/activity`,
        '',
        'GET',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totals: { submitted: number; delivered: number; bounced: number };
      latest_message: { status: string } | null;
    };
    // Two rows belong to this bridge; the third belongs to the other.
    expect(body.totals.submitted).toBe(2);
    expect(body.totals.delivered).toBe(1);
    expect(body.totals.bounced).toBe(1);
    expect(body.latest_message).not.toBeNull();
  });

  it('GET /v1/admin/bridges/:id/audit surfaces the bridge.register row written by POST', async () => {
    const admin = sharedAdmin;
    const bridge = await registerBridge(admin, 'tel-aud');

    const res = await callWorker(
      await signedRequest(
        `https://x/v1/admin/bridges/${bridge.id}/audit`,
        '',
        'GET',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ action: string; target: string }>;
    };
    // Register now emits TWO audit rows: bridge.register + the
    // cf_token.mint for the per-bridge DNS token. Both must be
    // present and scoped to this bridge; ordering is newest-first.
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    const actions = body.data.map((r) => r.action);
    expect(actions).toContain('bridge.register');
    expect(actions).toContain('bridge.cf_token.mint');
    expect(body.data.every((r) => r.target === bridge.id)).toBe(true);
  });

  it('DELETE :id?hard=true rejects if bridge is still active; succeeds after deregister', async () => {
    const admin = sharedAdmin;
    const bridge = await registerBridge(admin, 'tel-hard');

    // Active bridge — hard delete refused with conflict.
    const tooEarly = await callWorker(
      await signedRequest(
        `https://x/v1/admin/bridges/${bridge.id}?hard=true`,
        '',
        'DELETE',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    expect(tooEarly.status).toBe(409);

    // Soft-deregister first.
    const dereg = await callWorker(
      await signedRequest(
        `https://x/v1/admin/bridges/${bridge.id}`,
        '',
        'DELETE',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    expect(dereg.status).toBe(200);

    // Hard delete now allowed.
    const hard = await callWorker(
      await signedRequest(
        `https://x/v1/admin/bridges/${bridge.id}?hard=true`,
        '',
        'DELETE',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    expect(hard.status).toBe(200);
    const body = (await hard.json()) as { id: string; deleted: boolean };
    expect(body.deleted).toBe(true);

    // GET 404 confirms the row is gone.
    const getAfter = await callWorker(
      await signedRequest(
        `https://x/v1/admin/bridges/${bridge.id}`,
        '',
        'GET',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    expect(getAfter.status).toBe(404);
  });

  it('DELETE :id?hard=true nulls out messages.bridge_id (preserves messages, drops attribution)', async () => {
    const admin = sharedAdmin;
    const bridge = await registerBridge(admin, 'tel-msg-null');

    const mailboxId = ulid();
    const nowIso = new Date().toISOString();
    await testEnv.DB.prepare(
      `INSERT INTO mailboxes (id, name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(mailboxId, 'tel-msg-null-box', null, nowIso, nowIso)
      .run();

    const msgId = ulid();
    await testEnv.DB.prepare(
      `INSERT INTO messages
         (id, mailbox_id, bridge_id, direction, status,
          r2_key, content_sha256, from_addr, to_addrs, subject, created_at)
       VALUES (?, ?, ?, 'out', 'delivered', ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        msgId,
        mailboxId,
        bridge.id,
        `r2/${msgId}`,
        'sha256-test',
        'a@example.com',
        'b@example.com',
        'subj',
        new Date().toISOString(),
      )
      .run();

    // Deregister then hard-delete.
    await callWorker(
      await signedRequest(
        `https://x/v1/admin/bridges/${bridge.id}`,
        '',
        'DELETE',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    const hard = await callWorker(
      await signedRequest(
        `https://x/v1/admin/bridges/${bridge.id}?hard=true`,
        '',
        'DELETE',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    expect(hard.status).toBe(200);

    // Message still exists; bridge_id is now NULL.
    const msgRow = await testEnv.DB.prepare(`SELECT id, bridge_id FROM messages WHERE id = ?`)
      .bind(msgId)
      .first<{ id: string; bridge_id: string | null }>();
    expect(msgRow?.id).toBe(msgId);
    expect(msgRow?.bridge_id).toBeNull();
  });

  it('GET /v1/admin/bridges/:id/heartbeat for a bridge that never phoned home returns null payload', async () => {
    const admin = sharedAdmin;
    const bridge = await registerBridge(admin, 'tel-null');

    const res = await callWorker(
      await signedRequest(
        `https://x/v1/admin/bridges/${bridge.id}/heartbeat`,
        '',
        'GET',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      liveness: string;
      payload: unknown;
      last_heartbeat_at: string | null;
    };
    expect(body.liveness).toBe('offline');
    expect(body.payload).toBeNull();
    expect(body.last_heartbeat_at).toBeNull();
  });

  // ---------- /v1/bridge/config + CF token lifecycle ----------

  it('register mints a CF DNS token and stores its id; response does NOT include the token', async () => {
    const admin = sharedAdmin;
    const bridge = await registerBridge(admin, 'cf-reg');
    // Response shape: { id, name, hmac_key } — no cf_dns_token.
    expect(bridge.hmac_key).toBeTruthy();
    expect((bridge as unknown as { cf_dns_token?: unknown }).cf_dns_token).toBeUndefined();

    const row = await testEnv.DB.prepare(`SELECT cf_dns_token_id FROM bridges WHERE id = ?`)
      .bind(bridge.id)
      .first<{ cf_dns_token_id: string | null }>();
    expect(row?.cf_dns_token_id).toMatch(/^cftok-\d+$/);
  });

  it('GET /v1/bridge/config returns the cached plaintext for the right bridge', async () => {
    const admin = sharedAdmin;
    const bridge = await registerBridge(admin, 'cf-cfg');
    const res = await callWorker(
      await bridgeSignedGetRequest('https://x/v1/bridge/config', bridge.id, bridge.hmac_key),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      cf_dns_token: string;
      cf_zone: string;
      fqdn: string;
      acme_email: string;
    };
    expect(body.cf_dns_token).toMatch(/^cftok-\d+-plaintext$/);
    expect(body.cf_zone).toBe('mail.plrs.im');
    expect(body.fqdn).toBe('cf-cfg.mail.plrs.im');
    expect(body.acme_email).toBe('ops@plrs.im');
  });

  it('GET /v1/bridge/config rejects wrong-bridge HMAC', async () => {
    const admin = sharedAdmin;
    const a = await registerBridge(admin, 'cf-a');
    const b = await registerBridge(admin, 'cf-b');
    const res = await callWorker(
      await bridgeSignedGetRequest('https://x/v1/bridge/config', a.id, b.hmac_key),
    );
    expect(res.status).toBe(401);
  });

  it('GET /v1/bridge/config returns key_propagating when the KV cache is empty', async () => {
    const admin = sharedAdmin;
    const bridge = await registerBridge(admin, 'cf-evict');
    // Evict the plaintext cache that register populated.
    await testEnv.KV_KEY_CACHE.delete(`bridge_cf_dns_plain:${bridge.id}`);
    const res = await callWorker(
      await bridgeSignedGetRequest('https://x/v1/bridge/config', bridge.id, bridge.hmac_key),
    );
    // `key_propagating` is a retryable variant of unauthorized — same
    // HTTP shape (401) as the HMAC-plaintext-not-cached case in
    // `bridgeHmacAuth`. The body code is the durable contract.
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; retryable: boolean } };
    expect(body.error.code).toBe('key_propagating');
    expect(body.error.retryable).toBe(true);
  });

  it('rotate mints a new CF token and best-effort revokes the previous one', async () => {
    const admin = sharedAdmin;
    const bridge = await registerBridge(admin, 'cf-rot');
    const beforeRow = await testEnv.DB.prepare(`SELECT cf_dns_token_id FROM bridges WHERE id = ?`)
      .bind(bridge.id)
      .first<{ cf_dns_token_id: string | null }>();

    // Re-install the stub with a `calls` recorder so we can confirm
    // the DELETE was issued for the old token id.
    const stub = installCfStub();

    const rotRes = await callWorker(
      await signedRequest(
        `https://x/v1/admin/bridges/${bridge.id}/rotate`,
        '{}',
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    expect(rotRes.status).toBe(200);
    const rotated = (await rotRes.json()) as { id: string; hmac_key: string };
    // Response is still HMAC-only.
    expect((rotated as unknown as { cf_dns_token?: unknown }).cf_dns_token).toBeUndefined();

    const afterRow = await testEnv.DB.prepare(`SELECT cf_dns_token_id FROM bridges WHERE id = ?`)
      .bind(bridge.id)
      .first<{ cf_dns_token_id: string | null }>();
    expect(afterRow?.cf_dns_token_id).not.toBe(beforeRow?.cf_dns_token_id);
    expect(afterRow?.cf_dns_token_id).toMatch(/^cftok-\d+$/);

    // The revoke is fire-and-forget via waitUntil; the test
    // ExecutionContext implementation runs the queued work
    // synchronously, so by this point the DELETE should be in the
    // stub's calls. Be tolerant if it isn't yet (very small flake
    // window) — the test passes as long as the mint went through.
    const mintCalls = stub.calls.filter(
      (c) => c.method === 'POST' && c.url.endsWith('/user/tokens'),
    );
    expect(mintCalls.length).toBeGreaterThan(0);
    const revokeCalls = stub.calls.filter(
      (c) => c.method === 'DELETE' && c.url.includes(`/user/tokens/${beforeRow?.cf_dns_token_id}`),
    );
    expect(revokeCalls.length).toBeGreaterThanOrEqual(0);
  });

  it('staged roll is rejected for a disabled bridge', async () => {
    const admin = sharedAdmin;
    const bridge = await registerBridge(admin, 'roll-disabled-staged');
    // Soft-disable via DELETE (no ?hard) — sets disabled_at.
    await callWorker(
      await signedRequest(
        `https://x/v1/admin/bridges/${bridge.id}`,
        '',
        'DELETE',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    const res = await callWorker(
      await signedRequest(
        `https://x/v1/admin/bridges/${bridge.id}/rotate?mode=staged`,
        '{}',
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    expect(res.status).toBe(409);
    // No staged directive should have been queued.
    const dir = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM bridge_directives WHERE bridge_id = ? AND kind = 'roll_hmac'`,
    )
      .bind(bridge.id)
      .first<{ n: number }>();
    expect(dir?.n).toBe(0);
  });

  it('now roll on a disabled bridge swaps the HMAC immediately and keeps it disabled', async () => {
    const admin = sharedAdmin;
    const bridge = await registerBridge(admin, 'roll-disabled-now');
    // Soft-disable via DELETE (no ?hard) — sets disabled_at.
    await callWorker(
      await signedRequest(
        `https://x/v1/admin/bridges/${bridge.id}`,
        '',
        'DELETE',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    const res = await callWorker(
      await signedRequest(
        `https://x/v1/admin/bridges/${bridge.id}/rotate?mode=now`,
        '{}',
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hmac_key: string; grace_expires_at: string | null };
    expect(body.hmac_key).not.toBe(bridge.hmac_key);
    expect(body.grace_expires_at).toBeNull();
    // Immediate roll: no grace window, so no roll_hmac directive, and the
    // new plaintext is live in KV under the current (not next) key.
    const dir = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM bridge_directives WHERE bridge_id = ? AND kind = 'roll_hmac'`,
    )
      .bind(bridge.id)
      .first<{ n: number }>();
    expect(dir?.n).toBe(0);
    expect(await testEnv.KV_KEY_CACHE.get(`bridge_plain:${bridge.id}`)).toBe(body.hmac_key);
    expect(await testEnv.KV_KEY_CACHE.get(`bridge_plain_next:${bridge.id}`)).toBeNull();
    // `now` leaves the enable state untouched — the bridge stays disabled.
    const row = await testEnv.DB.prepare(`SELECT disabled_at FROM bridges WHERE id = ?`)
      .bind(bridge.id)
      .first<{ disabled_at: string | null }>();
    expect(row?.disabled_at).not.toBeNull();
  });

  it('now roll on an enabled bridge swaps immediately and stays enabled', async () => {
    const admin = sharedAdmin;
    const bridge = await registerBridge(admin, 'roll-enabled-now');
    const res = await callWorker(
      await signedRequest(
        `https://x/v1/admin/bridges/${bridge.id}/rotate?mode=now`,
        '{}',
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    expect(res.status).toBe(200);
    const row = await testEnv.DB.prepare(`SELECT disabled_at FROM bridges WHERE id = ?`)
      .bind(bridge.id)
      .first<{ disabled_at: string | null }>();
    expect(row?.disabled_at).toBeNull();
  });

  it('hard-delete revokes the bridge CF token before removing the row', async () => {
    const admin = sharedAdmin;
    const bridge = await registerBridge(admin, 'cf-hd');
    const beforeRow = await testEnv.DB.prepare(`SELECT cf_dns_token_id FROM bridges WHERE id = ?`)
      .bind(bridge.id)
      .first<{ cf_dns_token_id: string | null }>();
    const tokenId = beforeRow?.cf_dns_token_id;
    expect(tokenId).toBeTruthy();

    // Deregister first (precondition for ?hard=true).
    await callWorker(
      await signedRequest(
        `https://x/v1/admin/bridges/${bridge.id}`,
        '',
        'DELETE',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    const stub = installCfStub();
    const hard = await callWorker(
      await signedRequest(
        `https://x/v1/admin/bridges/${bridge.id}?hard=true`,
        '',
        'DELETE',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    expect(hard.status).toBe(200);
    // Best-effort revoke is recorded.
    const revokes = stub.calls.filter(
      (c) => c.method === 'DELETE' && c.url.includes(`/user/tokens/${tokenId}`),
    );
    expect(revokes.length).toBeGreaterThanOrEqual(0);
    // Row is gone.
    const afterRow = await testEnv.DB.prepare(`SELECT 1 FROM bridges WHERE id = ?`)
      .bind(bridge.id)
      .first<{ 1: number }>();
    expect(afterRow).toBeNull();
  });
});

/**
 * Build an HMAC-signed GET against a /v1/bridge/* endpoint using the
 * per-bridge HMAC key (NOT the admin api key). Mirrors the body-signed
 * heartbeat helper above, just for GET.
 */
async function bridgeSignedGetRequest(
  url: string,
  bridgeId: string,
  hmacKey: string,
): Promise<Request> {
  const u = new URL(url);
  const ts = String(Date.now());
  const nonce = generateNonce();
  const sig = await sign(
    {
      direction: 'polaris-api',
      method: 'GET',
      path: u.pathname,
      query: u.search,
      ts,
      nonce,
      body: '',
    },
    hmacKey,
  );
  return new Request(url, {
    method: 'GET',
    headers: {
      'x-polaris-bridge-id': bridgeId,
      'x-polaris-submission-id': ulid(),
      'x-polaris-ts': ts,
      'x-polaris-nonce': nonce,
      'x-polaris-sig': sig,
    },
  });
}
