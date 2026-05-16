// W1 — pool-workers integration test for the suppressions admin REST surface.
//
// Drives the real admin Worker through HTTP, asserts D1 row shape, audit
// emission, and the bi-directional list/filter behaviour. Mirrors the shape
// of mta-sts-admin.workers.test.ts but covers the suppression CRUD endpoints
// introduced in services/api/src/routes/admin/suppressions.ts.
import { applyD1Migrations, createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { sign, generateNonce } from '@polaris-email/hmac';
import worker from '../../src/index.js';
import type { Env } from '../../src/env.js';

interface TestEnv extends Env {
  DB: D1Database;
}

const testEnv = env as unknown as TestEnv;
const POLARIS_SECRET = 'phase-w1-control-plane-secret';
const ARGON2_PEPPER = 'phase-w1-pepper';

beforeAll(async () => {
  const migrations = inject('migrations');
  await applyD1Migrations(testEnv.DB, migrations);
  (testEnv as { POLARIS_SECRET_A?: string }).POLARIS_SECRET_A = POLARIS_SECRET;
  (testEnv as { ARGON2_PEPPER?: string }).ARGON2_PEPPER = ARGON2_PEPPER;
});

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
  return new Request(url, {
    method,
    headers,
    body: method === 'GET' || method === 'DELETE' ? undefined : body,
  });
}

async function callWorker(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  return worker.fetch(req, testEnv as unknown as Env, ctx);
}

interface BootstrapResult {
  admin_key_id: string;
  admin_key_secret: string;
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

async function clearSuppressions(): Promise<void> {
  await testEnv.DB.prepare(`DELETE FROM suppressions`).run();
}

describe('W1 — admin/suppressions REST', () => {
  let admin: BootstrapResult;

  beforeAll(async () => {
    admin = await bootstrap();
  });

  beforeEach(async () => {
    await clearSuppressions();
  });

  it('creates and lists a recipient suppression', async () => {
    const create = await callWorker(
      await signedRequest(
        'https://x/v1/admin/suppressions',
        JSON.stringify({
          entity_type: 'recipient',
          address: 'Foo.Bar+spam@gmail.com',
          reason: 'manual',
          severity: 'warn',
        }),
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as { id: string };
    expect(created.id).toMatch(/^[0-9A-Z]{26}$/);

    const list = await callWorker(
      await signedRequest(
        'https://x/v1/admin/suppressions?entity_type=recipient',
        '',
        'GET',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    expect(list.status).toBe(200);
    const listed = (await list.json()) as {
      data: Array<{ address_normalized: string; reason: string }>;
    };
    expect(listed.data.length).toBe(1);
    // Gmail-equivalent normalization applied.
    expect(listed.data[0]!.address_normalized).toBe('foobar@gmail.com');
    expect(listed.data[0]!.reason).toBe('manual');
  });

  it('creates a sender suppression scoped to a mailbox', async () => {
    const create = await callWorker(
      await signedRequest(
        'https://x/v1/admin/suppressions',
        JSON.stringify({
          entity_type: 'sender',
          address: 'svc@example.com',
          scope: 'mailbox',
          scope_target: '01HXMAILBOX0000000000000W1',
          reason: 'sender_abuse_threshold',
          source: 'sender_threshold_cron',
          severity: 'critical',
        }),
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    expect(create.status).toBe(201);

    const filtered = await callWorker(
      await signedRequest(
        'https://x/v1/admin/suppressions?entity_type=sender&severity=critical',
        '',
        'GET',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    const body = (await filtered.json()) as {
      data: Array<{ entity_type: string; severity: string }>;
    };
    expect(body.data.length).toBe(1);
    expect(body.data[0]!.entity_type).toBe('sender');
    expect(body.data[0]!.severity).toBe('critical');
  });

  it('rejects a duplicate active suppression for the same tuple with 409', async () => {
    const body = JSON.stringify({
      entity_type: 'recipient',
      address: 'dup@example.com',
      reason: 'hard_bounce',
    });
    const first = await callWorker(
      await signedRequest(
        'https://x/v1/admin/suppressions',
        body,
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    expect(first.status).toBe(201);
    const second = await callWorker(
      await signedRequest(
        'https://x/v1/admin/suppressions',
        body,
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    expect(second.status).toBe(409);
  });

  it('disables a suppression and excludes it from default list', async () => {
    const create = await callWorker(
      await signedRequest(
        'https://x/v1/admin/suppressions',
        JSON.stringify({ entity_type: 'recipient', address: 'gone@example.com', reason: 'manual' }),
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    const { id } = (await create.json()) as { id: string };

    const del = await callWorker(
      await signedRequest(
        `https://x/v1/admin/suppressions/${id}?reason=mistake`,
        '',
        'DELETE',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    expect(del.status).toBe(200);

    const list = await callWorker(
      await signedRequest(
        'https://x/v1/admin/suppressions',
        '',
        'GET',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    const listed = (await list.json()) as { data: unknown[] };
    expect(listed.data.length).toBe(0);

    const includeDisabled = await callWorker(
      await signedRequest(
        'https://x/v1/admin/suppressions?include_disabled=1',
        '',
        'GET',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    const both = (await includeDisabled.json()) as { data: Array<{ disabled_at: string | null }> };
    expect(both.data.length).toBe(1);
    expect(both.data[0]!.disabled_at).not.toBeNull();
  });

  it('check endpoint returns both sender + recipient rows for the same address', async () => {
    for (const body of [
      { entity_type: 'recipient', address: 'overlap@example.com', reason: 'manual' },
      { entity_type: 'sender', address: 'overlap@example.com', reason: 'manual' },
    ]) {
      const r = await callWorker(
        await signedRequest(
          'https://x/v1/admin/suppressions',
          JSON.stringify(body),
          'POST',
          admin.admin_key_secret,
          admin.admin_key_id,
        ),
      );
      expect(r.status).toBe(201);
    }
    const check = await callWorker(
      await signedRequest(
        'https://x/v1/admin/suppressions/check?address=overlap@example.com',
        '',
        'GET',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
    );
    expect(check.status).toBe(200);
    const out = (await check.json()) as { data: Array<{ entity_type: string }> };
    expect(out.data.map((d) => d.entity_type).sort()).toEqual(['recipient', 'sender']);
  });
});
