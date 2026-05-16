// Phase B.8 — pool-workers integration test for services/api's send path.
//
// Drives the real Hono Worker (`worker.fetch`) end-to-end against the
// Miniflare-simulated D1/R2/KV/Queue bindings provided by
// `@cloudflare/vitest-pool-workers`. Compared to the mock-backed
// integration tests in `*.integration.test.ts`, this exercises the real
// storage substrate (workerd D1 with our migrations applied via
// `applyD1Migrations`) and proves the send round-trip without any
// in-memory shims.
//
// Quirks vs B.5 (services/in) and B.7 (services/out):
//   - services/api is fetch-based. Unlike the email handler in services/in
//     (`worker.email!()` directly) and the queue consumer in services/out
//     (`worker.queue!()` directly), here we invoke the worker's default
//     export directly: `worker.fetch(req, env, ctx)`. Going through
//     `SELF.fetch()` works in pool-workers for normal HTTP routes (unlike
//     the `cdn-cgi/handler/email` shim) but routes through a fresh isolate
//     that doesn't see per-test binding overrides such as the
//     OUTBOUND_QUEUE recorder reassignment below. Direct invocation keeps
//     the override visible.
//   - The OUTBOUND_QUEUE producer binding is overridden per-test by
//     reassigning `testEnv.OUTBOUND_QUEUE` to an in-process recorder stub.
//     The recorder captures `.send()` and `.sendBatch()` payloads so we
//     can assert the canonical OutboundQueueMessage shape that downstream
//     `services/out` consumes.
//   - Migrations are loaded in Node (via `global-setup.ts`) and forwarded
//     into the worker isolate through vitest's `inject()` channel —
//     importing `@cloudflare/vitest-pool-workers` directly from a test
//     file that runs inside workerd crashes the runtime.
import { applyD1Migrations, createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { sign, generateNonce } from '@polaris-email/hmac';
import worker from '../../src/index.js';
import type { Env, OutboundQueueMessage } from '../../src/env.js';

interface TestEnv extends Env {
  DB: D1Database;
  R2: R2Bucket;
  KV_NONCE: KVNamespace;
  KV_IDEMPOTENCY: KVNamespace;
  KV_RATE_LIMIT: KVNamespace;
  KV_KEY_CACHE: KVNamespace;
  KV_REVOCATIONS: KVNamespace;
  OUTBOUND_QUEUE: Queue<OutboundQueueMessage>;
}

const testEnv = env as unknown as TestEnv;

// Inject the secret used by /v1/admin/bootstrap. wrangler.test.jsonc does not
// declare it (test-config files shouldn't carry secrets); we patch it onto
// the env in beforeAll so the integration suite is self-contained.
const POLARIS_SECRET = 'phase-b8-control-plane-secret';
const ARGON2_PEPPER = 'phase-b8-pepper';

function buildExecutionContext(): ExecutionContext {
  return createExecutionContext();
}

/** Sign-and-build a polaris-api HMAC request to the api Worker. Mirrors
 *  `services/api/test/integration/setup.ts`'s signedRequest but is dependency-
 *  free (only imports `@polaris-email/hmac`) so it works inside workerd. */
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
  const ctx = buildExecutionContext();
  return worker.fetch(req, testEnv as unknown as Env, ctx);
}

interface BootstrapResult {
  admin_key_id: string;
  admin_key_secret: string;
  mailbox_id: string;
}

async function bootstrap(): Promise<BootstrapResult> {
  // Bootstrap signs with POLARIS_SECRET_A directly (not an api-key); the
  // `x-polaris-key-id` header must be absent so the request routes to
  // bootstrap's signature check instead of the api-key hmacAuth middleware.
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

async function createMailbox(admin: BootstrapResult, name: string): Promise<string> {
  const res = await callWorker(
    await signedRequest(
      'https://x/v1/admin/mailboxes',
      JSON.stringify({ name }),
      'POST',
      admin.admin_key_secret,
      admin.admin_key_id,
    ),
  );
  if (res.status !== 201) {
    throw new Error(`createMailbox failed: ${res.status} ${await res.text()}`);
  }
  return ((await res.json()) as { id: string }).id;
}

async function issueApiKey(
  admin: BootstrapResult,
  mailboxId: string,
  scopes: string[],
): Promise<{ key_id: string; key_secret: string }> {
  const res = await callWorker(
    await signedRequest(
      'https://x/v1/admin/api-keys',
      JSON.stringify({ mailbox_id: mailboxId, scopes }),
      'POST',
      admin.admin_key_secret,
      admin.admin_key_id,
    ),
  );
  if (res.status !== 201) {
    throw new Error(`issueApiKey failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as { key_id: string; key_secret: string };
}

async function seedVerifiedDomain(name: string): Promise<string> {
  const id = '01HX00DOMAIN0000000000000B8';
  const zoneId = '01HX00ZONE000000000000000B8';
  const nowIso = new Date().toISOString();
  // mail_domains.zone_id is FK to zones(id), so we must seed the zone first.
  await testEnv.DB.prepare(
    `INSERT INTO zones (id, cf_zone_id, name, created_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(zoneId, 'cfz-b8', name, nowIso)
    .run();
  await testEnv.DB.prepare(
    `INSERT INTO mail_domains (id, zone_id, name, status, verified_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, zoneId, name, 'verified', nowIso, nowIso, nowIso)
    .run();
  return id;
}

interface OutboundCapture {
  body: OutboundQueueMessage;
}

function makeQueueRecorder(): {
  sent: OutboundCapture[];
  binding: Queue<OutboundQueueMessage>;
} {
  const sent: OutboundCapture[] = [];
  const binding = {
    async send(msg: OutboundQueueMessage) {
      sent.push({ body: msg });
    },
    async sendBatch(msgs: Array<{ body: OutboundQueueMessage }>) {
      for (const m of msgs) sent.push({ body: m.body });
    },
  } as unknown as Queue<OutboundQueueMessage>;
  return { sent, binding };
}

beforeAll(async () => {
  // `inject('migrations')` is populated by `test/integration/global-setup.ts`
  // running in Node before any worker isolate is booted.
  const migrations = inject('migrations');
  await applyD1Migrations(testEnv.DB, migrations);

  // Workerd quirk: migration 0006 does `ALTER TABLE messages RENAME TO
  // messages_old; ... CREATE TABLE messages ...; DROP TABLE messages_old;`
  // to rebuild `messages` with a retargeted FK. SQLite (and real D1) tolerate
  // the dangling FK references in `idempotency_keys.message_id` /
  // `message_attempts.message_id` / `message_deliveries.message_id` because
  // the migration sets `PRAGMA foreign_keys = OFF` and DROPs `messages_old`.
  // Workerd's D1 simulator enforces FK lookups by NAME on subsequent INSERT
  // statements and errors with "no such table: main.messages_old" the next
  // time any of those tables is written to. Rebuild them here against the
  // post-0006 `messages` table so the production code paths (`tryClaim` etc.)
  // succeed unmodified.
  await testEnv.DB.prepare(`DROP TABLE idempotency_keys`).run();
  await testEnv.DB.prepare(
    `CREATE TABLE idempotency_keys (
       principal_id TEXT NOT NULL,
       key          TEXT NOT NULL,
       mailbox_id   TEXT NOT NULL REFERENCES mailboxes(id),
       message_id   TEXT REFERENCES messages(id),
       expires_at   TEXT,
       created_at   TEXT NOT NULL,
       PRIMARY KEY (principal_id, key)
     )`,
  ).run();
  await testEnv.DB.prepare(
    `CREATE INDEX idx_idempotency_keys_expires_at ON idempotency_keys (expires_at)`,
  ).run();

  await testEnv.DB.prepare(`DROP TABLE message_attempts`).run();
  await testEnv.DB.prepare(
    `CREATE TABLE message_attempts (
       id              TEXT PRIMARY KEY,
       message_id      TEXT NOT NULL REFERENCES messages(id),
       send_attempt_id TEXT,
       attempted_at    TEXT NOT NULL,
       succeeded       INTEGER NOT NULL,
       error           TEXT
     )`,
  ).run();
  await testEnv.DB.prepare(
    `CREATE INDEX idx_message_attempts_message_id ON message_attempts(message_id)`,
  ).run();

  await testEnv.DB.prepare(`DROP TABLE message_deliveries`).run();
  await testEnv.DB.prepare(
    `CREATE TABLE message_deliveries (
       message_id         TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
       webhook_sub_id     TEXT NOT NULL REFERENCES webhook_subs(id) ON DELETE CASCADE,
       status             TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed','dlq')),
       attempts           INTEGER NOT NULL DEFAULT 0,
       next_attempt_at    TEXT,
       last_error         TEXT,
       last_response_code INTEGER,
       created_at         TEXT NOT NULL,
       PRIMARY KEY (message_id, webhook_sub_id)
     )`,
  ).run();
  await testEnv.DB.prepare(
    `CREATE INDEX idx_message_deliveries_status ON message_deliveries(status)`,
  ).run();

  // Patch in the bootstrap-gating secret + argon2 pepper. wrangler.test.jsonc
  // intentionally omits these (test config shouldn't carry secrets); they
  // become per-isolate env entries here.
  (testEnv as unknown as Record<string, unknown>).POLARIS_SECRET_A = POLARIS_SECRET;
  (testEnv as unknown as Record<string, unknown>).ARGON2_PEPPER = ARGON2_PEPPER;
});

describe('services/api send round-trip (pool-workers)', () => {
  it('spike: GET /healthz returns 200 through worker.fetch()', async () => {
    // Sanity check that the worker plumbing is wired. If this fails, no
    // amount of bootstrap fiddling will help.
    const res = await callWorker(new Request('https://x/healthz'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('golden path: POST /v1/messages enqueues an OutboundQueueMessage and writes a queued D1 row', async () => {
    const admin = await bootstrap();
    const mbId = await createMailbox(admin, 'send-roundtrip-mb');
    await seedVerifiedDomain('example.com');
    const key = await issueApiKey(admin, mbId, ['send']);

    const recorder = makeQueueRecorder();
    (testEnv as unknown as Record<string, unknown>).OUTBOUND_QUEUE = recorder.binding;

    const sendBody = {
      from: 'noreply@example.com',
      to: ['inbox@example.org'],
      subject: 'hello from B8',
      text: 'phase-b8 round-trip body',
    };
    const res = await callWorker(
      await signedRequest(
        'https://x/v1/messages',
        JSON.stringify(sendBody),
        'POST',
        key.key_secret,
        key.key_id,
      ),
    );
    const responseText = await res.text();
    expect(res.status, `expected 202, got ${res.status}: ${responseText}`).toBe(202);
    const responseJson = JSON.parse(responseText) as {
      message_id: string;
      status: string;
      fresh: boolean;
    };
    expect(responseJson.message_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/i); // ULID shape
    expect(responseJson.status).toBe('queued');
    expect(responseJson.fresh).toBe(true);
    const messageId = responseJson.message_id;

    // D1 row written by processMessage()
    const row = await testEnv.DB.prepare(
      `SELECT id, status, direction, mailbox_id, from_addr FROM messages WHERE id = ?`,
    )
      .bind(messageId)
      .first<{
        id: string;
        status: string;
        direction: string;
        mailbox_id: string;
        from_addr: string;
      }>();
    expect(row).toBeTruthy();
    expect(row!.status).toBe('queued');
    expect(row!.direction).toBe('out');
    expect(row!.mailbox_id).toBe(mbId);
    expect(row!.from_addr).toBe('noreply@example.com');

    // OUTBOUND_QUEUE recorder captured exactly one message with the canonical
    // shape that services/out consumes.
    expect(recorder.sent.length).toBe(1);
    const enqueued = recorder.sent[0]!.body;
    expect(enqueued.messageId).toBe(messageId);
    expect(enqueued.source).toBe('raw');
    expect(enqueued.fromDomain).toBe('example.com');
    expect(enqueued.fromAddress).toBe('noreply@example.com');
    expect(enqueued.mailboxId).toBe(mbId);
    expect(enqueued.mode).toBe('live');
    expect(enqueued.retries).toBe(0);
    expect(enqueued.r2KeyOrInline).toMatch(/.+/);

    // R2 should have the canonical RFC822 bytes under the key in the queue
    // payload — proves the producer wrote what the consumer will read.
    const obj = await testEnv.R2.get(enqueued.r2KeyOrInline);
    expect(obj).not.toBeNull();
  });
});
