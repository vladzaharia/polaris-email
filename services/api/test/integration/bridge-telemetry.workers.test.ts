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
import { beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
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
  sharedAdmin = await runBootstrap();
});

beforeEach(async () => {
  // Wipe only the rows tests create — leave the genesis admin api_key /
  // root operator alone so `sharedAdmin` keeps authenticating.
  await testEnv.DB.prepare(`DELETE FROM messages`).run();
  await testEnv.DB.prepare(`DELETE FROM bridges`).run();
});

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

const validHeartbeatBody = () => ({
  schema_version: 1 as const,
  bridge_version: '0.1.0-test',
  uptime_seconds: 300,
  imap_sessions_active: 2,
  smtp_submissions_24h: 17,
  errors_24h: 0,
  mirror_message_count: 42,
  reported_at: new Date().toISOString(),
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
    expect(hbRes.status).toBe(204);

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
      imap_sessions_active: 2,
      smtp_submissions_24h: 17,
      mirror_message_count: 42,
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

  it('rejects heartbeat with invalid body shape', async () => {
    const admin = sharedAdmin;
    const bridge = await registerBridge(admin, 'tel-bad');

    const res = await callWorker(
      await bridgeHeartbeatRequest(bridge.id, bridge.hmac_key, {
        schema_version: 1,
        bridge_version: '',
        uptime_seconds: 0,
        imap_sessions_active: 0,
        smtp_submissions_24h: 0,
        errors_24h: 0,
        mirror_message_count: 0,
        reported_at: new Date().toISOString(),
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
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data[0]?.action).toBe('bridge.register');
    expect(body.data[0]?.target).toBe(bridge.id);
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
});
