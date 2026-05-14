import { describe, expect, it } from 'vitest';
import app from '../src/index.js';
import { mkEnv } from './mocks.js';
import { sign, generateNonce } from '@polaris-email/hmac';
import { mintAttachmentUrl } from '@polaris-email/cf-api';

// Use an execution context that captures waitUntil promises so KV writes complete
const ctx = {
  passThroughOnException: () => undefined,
  waitUntil: (p: Promise<unknown>) => p,
} as unknown as ExecutionContext;

async function signedRequest(
  url: string,
  body: string,
  method: string,
  secret: string,
  keyId: string,
  extraHeaders: Record<string, string> = {},
) {
  const u = new URL(url);
  const ts = String(Date.now());
  const nonce = generateNonce();
  const sig = await sign(
    {
      direction: 'polaris-api.v1',
      method,
      path: u.pathname,
      query: u.search,
      ts,
      nonce,
      body,
    },
    secret,
  );
  return new Request(url, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-polaris-key-id': keyId,
      'x-polaris-ts': ts,
      'x-polaris-nonce': nonce,
      'x-polaris-sig': sig,
      ...extraHeaders,
    },
    body: method === 'GET' ? undefined : body,
  });
}

async function bootstrapEnv() {
  const env = mkEnv();
  // POST /v1/admin/bootstrap signed with POLARIS_SECRET_A
  const body = '{}';
  const req = await signedRequest(
    'https://polaris-email-api.workers.dev/v1/admin/bootstrap',
    body,
    'POST',
    env.POLARIS_SECRET_A!,
    '01HXR0000000000000000000A8', // key id not validated for bootstrap path
  );
  // bootstrap doesn't go through hmacAuth middleware; needs no X-Polaris-Key-Id
  const cleanReq = new Request(req, {
    headers: (() => {
      const h = new Headers(req.headers);
      h.delete('x-polaris-key-id');
      return h;
    })(),
  });
  const res = await app.fetch(cleanReq, env, ctx);
  if (res.status !== 200) {
    throw new Error('bootstrap failed: ' + res.status + ' ' + (await res.text()));
  }
  const j = (await res.json()) as {
    admin_key_id: string;
    admin_key_secret: string;
    mailbox_id: string;
  };
  return { env, admin: j };
}

describe('healthz', () => {
  it('200', async () => {
    const env = mkEnv();
    const res = await app.fetch(new Request('https://x/healthz'), env, ctx);
    expect(res.status).toBe(200);
  });
});

describe('bootstrap', () => {
  it('issues an admin key + operator mailbox once', async () => {
    const { env, admin } = await bootstrapEnv();
    expect(admin.admin_key_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(admin.admin_key_secret).toMatch(/^[0-9A-Z]+$/);
    expect(admin.mailbox_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    // operator mailbox exists in the DB
    const mockDb = env.DB as unknown as { tables: Map<string, Record<string, unknown>[]> };
    const mb = (mockDb.tables.get('mailboxes') ?? []).find((r) => r['name'] === 'operator');
    expect(mb?.['id']).toBe(admin.mailbox_id);

    // Second call should 409
    const req = await signedRequest(
      'https://polaris-email-api.workers.dev/v1/admin/bootstrap',
      '{}',
      'POST',
      env.POLARIS_SECRET_A!,
      '01HXR0000000000000000000A8',
    );
    const clean = new Request(req, {
      headers: (() => {
        const h = new Headers(req.headers);
        h.delete('x-polaris-key-id');
        return h;
      })(),
    });
    const res = await app.fetch(clean, env, ctx);
    expect(res.status).toBe(409);
  });

  it('rejects bad signature', async () => {
    const env = mkEnv();
    const req = new Request('https://polaris-email-api.workers.dev/v1/admin/bootstrap', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-polaris-ts': String(Date.now()),
        'x-polaris-nonce': generateNonce(),
        'x-polaris-sig': 'v1=' + 'a'.repeat(64),
      },
      body: '{}',
    });
    const res = await app.fetch(req, env, ctx);
    expect(res.status).toBe(401);
  });
});

async function createMailbox(
  env: ReturnType<typeof mkEnv>,
  admin: { admin_key_id: string; admin_key_secret: string },
  name: string,
): Promise<string> {
  const res = await app.fetch(
    await signedRequest(
      'https://x/v1/admin/mailboxes',
      JSON.stringify({ name }),
      'POST',
      admin.admin_key_secret,
      admin.admin_key_id,
    ),
    env,
    ctx,
  );
  if (res.status !== 201) throw new Error('createMailbox failed ' + res.status);
  return ((await res.json()) as { id: string }).id;
}

describe('admin mailboxes', () => {
  it('creates and lists mailboxes', async () => {
    const { env, admin } = await bootstrapEnv();
    const mbId = await createMailbox(env, admin, 'expresscharge');
    expect(mbId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    const listRes = await app.fetch(
      await signedRequest(
        'https://x/v1/admin/mailboxes',
        '',
        'GET',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { data: { name: string }[] };
    const names = list.data.map((r) => r.name);
    expect(names).toContain('operator');
    expect(names).toContain('expresscharge');
  });

  it('returns mailbox detail with senders + receivers + principals', async () => {
    const { env, admin } = await bootstrapEnv();
    const mbId = await createMailbox(env, admin, 'detail-mb');
    const res = await app.fetch(
      await signedRequest(
        `https://x/v1/admin/mailboxes/${mbId}`,
        '',
        'GET',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mailbox: { id: string };
      senders: unknown[];
      receivers: unknown[];
      principals: unknown[];
      webhook_subs: unknown[];
    };
    expect(body.mailbox.id).toBe(mbId);
    expect(Array.isArray(body.senders)).toBe(true);
    expect(Array.isArray(body.receivers)).toBe(true);
  });

  it('rejects duplicate mailbox name with 409', async () => {
    const { env, admin } = await bootstrapEnv();
    await createMailbox(env, admin, 'dup');
    const res = await app.fetch(
      await signedRequest(
        'https://x/v1/admin/mailboxes',
        JSON.stringify({ name: 'dup' }),
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    expect(res.status).toBe(409);
  });

  it('disables and re-enables a mailbox', async () => {
    const { env, admin } = await bootstrapEnv();
    const mbId = await createMailbox(env, admin, 'toggleable');
    const dRes = await app.fetch(
      await signedRequest(
        `https://x/v1/admin/mailboxes/${mbId}/disable`,
        '{}',
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    expect(dRes.status).toBe(200);
    const eRes = await app.fetch(
      await signedRequest(
        `https://x/v1/admin/mailboxes/${mbId}/enable`,
        '{}',
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    expect(eRes.status).toBe(200);
  });
});

describe('admin api-keys', () => {
  it('issues a mailbox-scoped key and uses it', async () => {
    const { env, admin } = await bootstrapEnv();
    const mbId = await createMailbox(env, admin, 'expresscharge');

    // Create domain (verified)
    {
      const isoNow = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO mail_domains (id, zone_id, name, status, verified_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind('01HX00DOMAIN0000000000ABCE', '01HX00ZONE000000000000ABCE', 'example.com', 'verified', isoNow, isoNow, isoNow)
        .run();
    }

    // Issue api key bound to the mailbox.
    const body = JSON.stringify({
      mailbox_id: mbId,
      scopes: ['send'],
    });
    const req = await signedRequest(
      'https://x/v1/admin/api-keys',
      body,
      'POST',
      admin.admin_key_secret,
      admin.admin_key_id,
    );
    const res = await app.fetch(req, env, ctx);
    expect(res.status).toBe(201);
    const issued = (await res.json()) as { key_id: string; key_secret: string };
    expect(issued.key_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(issued.key_secret.length).toBeGreaterThan(20);
  });

  it('rotation does not leak secret on idem replay', async () => {
    const { env, admin } = await bootstrapEnv();
    const mbId = await createMailbox(env, admin, 'svc');
    const issued = (await (
      await app.fetch(
        await signedRequest(
          'https://x/v1/admin/api-keys',
          JSON.stringify({ mailbox_id: mbId }),
          'POST',
          admin.admin_key_secret,
          admin.admin_key_id,
        ),
        env,
        ctx,
      )
    ).json()) as { key_id: string; key_secret: string };
    const idem = 'rot-' + 'q'.repeat(20);
    const r1 = await app.fetch(
      await signedRequest(
        `https://x/v1/admin/api-keys/${issued.key_id}/rotate`,
        JSON.stringify({ mode: 'planned' }),
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
        { 'idempotency-key': idem },
      ),
      env,
      ctx,
    );
    expect(r1.status).toBe(200);
    const j1 = (await r1.json()) as { new_key_id: string; new_key_secret: string };
    expect(j1.new_key_secret.length).toBeGreaterThan(20);
    const r2 = await app.fetch(
      await signedRequest(
        `https://x/v1/admin/api-keys/${issued.key_id}/rotate`,
        JSON.stringify({ mode: 'planned' }),
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
        { 'idempotency-key': idem },
      ),
      env,
      ctx,
    );
    const j2 = (await r2.json()) as { status?: string; new_key_secret?: string };
    expect(j2.status).toBe('already_rotated');
    expect(j2.new_key_secret).toBeUndefined();
  });

  it('emergency revoke kills the key immediately', async () => {
    const { env, admin } = await bootstrapEnv();
    const mbId = await createMailbox(env, admin, 'svc');
    await env.DB.prepare(
      `INSERT INTO mail_domains (id, zone_id, name, status, verified_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind('01HX00DOMAIN0000000000ABCD', '01HX00ZONE000000000000ABCD', 'example.com', 'verified', new Date().toISOString(), new Date().toISOString(), new Date().toISOString())
      .run();
    const issued = (await (
      await app.fetch(
        await signedRequest(
          'https://x/v1/admin/api-keys',
          JSON.stringify({ mailbox_id: mbId }),
          'POST',
          admin.admin_key_secret,
          admin.admin_key_id,
        ),
        env,
        ctx,
      )
    ).json()) as { key_id: string; key_secret: string };
    const revRes = await app.fetch(
      await signedRequest(
        `https://x/v1/admin/api-keys/${issued.key_id}/revoke`,
        JSON.stringify({ mode: 'emergency', reason: 'leak' }),
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    expect(revRes.status).toBe(200);
    const mockDb = env.DB as unknown as { tables: Map<string, Record<string, unknown>[]> };
    const keyRow = (mockDb.tables.get('api_keys') ?? []).find((r) => r['id'] === issued.key_id);
    expect(keyRow?.['status']).toBe('revoked');
  });
});

describe('webhook subs', () => {
  it('rejects external http (must be https)', async () => {
    const { env, admin } = await bootstrapEnv();
    const mbId = await createMailbox(env, admin, 'wh-mb-a');
    const res = await app.fetch(
      await signedRequest(
        'https://x/v1/admin/webhook-subs',
        JSON.stringify({
          mailbox_id: mbId,
          url: 'http://evil.example/hook',
          kind: 'external',
          events: ['message.received'],
        }),
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
  });
  it('rejects tailnet without .ts.net', async () => {
    const { env, admin } = await bootstrapEnv();
    const mbId = await createMailbox(env, admin, 'wh-mb-b');
    const res = await app.fetch(
      await signedRequest(
        'https://x/v1/admin/webhook-subs',
        JSON.stringify({
          mailbox_id: mbId,
          url: 'https://service.local/hook',
          kind: 'tailnet',
          events: ['message.received'],
        }),
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
  });
});

describe('domains + senders', () => {
  it('full create→sender→smtp-credential flow', async () => {
    const { env, admin } = await bootstrapEnv();
    const mbId = await createMailbox(env, admin, 'plrs-mb');

    // Create mail domain
    let res = await app.fetch(
      await signedRequest(
        'https://x/v1/admin/domains',
        JSON.stringify({ name: 'plrs.im' }),
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    expect(res.status).toBe(201);
    const dom = (await res.json()) as { id: string; name: string; status: string };
    expect(dom.name).toBe('plrs.im');
    expect(dom.status).toBe('pending');

    // Duplicate → 409
    res = await app.fetch(
      await signedRequest(
        'https://x/v1/admin/domains',
        JSON.stringify({ name: 'plrs.im' }),
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    expect(res.status).toBe(409);

    // List
    res = await app.fetch(
      await signedRequest(
        'https://x/v1/admin/domains',
        '',
        'GET',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const list = (await res.json()) as { data: { name: string; status: string }[] };
    expect(list.data[0]?.name).toBe('plrs.im');

    // Add sender (mailbox_id supplied in body)
    res = await app.fetch(
      await signedRequest(
        `https://x/v1/admin/domains/${dom.id}/senders`,
        JSON.stringify({
          mailbox_id: mbId,
          local_part: 'noreply',
          default_for_mailbox: true,
        }),
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    expect(res.status).toBe(201);
    const sender = (await res.json()) as { id: string; address: string };
    expect(sender.address).toBe('noreply@plrs.im');

    // Issue SMTP cred
    res = await app.fetch(
      await signedRequest(
        `https://x/v1/admin/senders/${sender.id}/smtp-credentials`,
        JSON.stringify({ label: 'expresscharge-prod' }),
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    expect(res.status).toBe(201);
    const cred = (await res.json()) as { id: string; username: string; secret: string };
    expect(cred.username).toBe('noreply@plrs.im');
    expect(cred.secret.length).toBeGreaterThan(20);

    // The submission_credentials row carries the bcrypt_hash (NOT the
    // plaintext) and binds 1:1 to the sender via `sender_id`.
    const mockDb = env.DB as unknown as { tables: Map<string, Record<string, unknown>[]> };
    const credRows = mockDb.tables.get('submission_credentials') ?? [];
    const credRow = credRows.find((r) => r['username'] === 'noreply@plrs.im');
    expect(credRow).toBeTruthy();
    expect(credRow?.['id']).toBe(cred.id);
    expect(credRow?.['sender_id']).toBe(sender.id);
    expect(typeof credRow?.['bcrypt_hash']).toBe('string');
    expect(credRow?.['bcrypt_hash']).not.toBe(cred.secret);
    // Plaintext must not appear in any column of any row of any table.
    for (const [, rows] of mockDb.tables) {
      for (const row of rows) {
        for (const v of Object.values(row)) {
          if (typeof v === 'string') {
            expect(v.includes(cred.secret)).toBe(false);
          }
        }
      }
    }

    // Verify endpoint: with no CF_API_TOKEN / no cf_zone_id in test env, the
    // verifier returns a 200 diagnostic envelope leaving status unchanged.
    res = await app.fetch(
      await signedRequest(
        `https://x/v1/admin/domains/${dom.id}/verify`,
        '{}',
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const verified = (await res.json()) as {
      status: string;
      checks?: { name: string; ok: boolean }[];
      message?: string;
    };
    expect(verified.status).toBe('pending');
    expect(verified.message).toBe('verification incomplete');
    expect(Array.isArray(verified.checks)).toBe(true);
  });
});

describe('daemon credential mirror', () => {
  it('returns the issued SMTP credential to the daemon poller', async () => {
    const { env, admin } = await bootstrapEnv();
    const mbId = await createMailbox(env, admin, 'daemon-mb');
    await app.fetch(
      await signedRequest(
        'https://x/v1/admin/domains',
        JSON.stringify({ name: 'plrs.im' }),
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    const dom = (await (
      await app.fetch(
        await signedRequest(
          'https://x/v1/admin/domains/lookup?name=plrs.im',
          '',
          'GET',
          admin.admin_key_secret,
          admin.admin_key_id,
        ),
        env,
        ctx,
      )
    ).json()) as { id: string };
    const sender = (await (
      await app.fetch(
        await signedRequest(
          `https://x/v1/admin/domains/${dom.id}/senders`,
          JSON.stringify({
            mailbox_id: mbId,
            local_part: 'noreply',
            default_for_mailbox: true,
          }),
          'POST',
          admin.admin_key_secret,
          admin.admin_key_id,
        ),
        env,
        ctx,
      )
    ).json()) as { id: string; address: string };
    const cred = (await (
      await app.fetch(
        await signedRequest(
          `https://x/v1/admin/senders/${sender.id}/smtp-credentials`,
          JSON.stringify({ label: 'test' }),
          'POST',
          admin.admin_key_secret,
          admin.admin_key_id,
        ),
        env,
        ctx,
      )
    ).json()) as { id: string; username: string; secret: string };

    const r = await app.fetch(
      await signedRequest(
        'https://x/v1/daemon/credentials?since=0',
        '',
        'GET',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      updates: { id: string; username: string; bcrypt_hash: string; allowed_senders: string[] }[];
      deletions: string[];
      mirror_version: number;
    };
    expect(Array.isArray(body.updates)).toBe(true);
    const u = body.updates.find((x) => x.id === cred.id);
    expect(u).toBeTruthy();
    expect(u?.username).toBe('noreply@plrs.im');
    expect(typeof u?.bcrypt_hash).toBe('string');
    expect(u?.bcrypt_hash).not.toBe(cred.secret);
    expect(u?.allowed_senders).toEqual(['noreply@plrs.im']);
    expect(body.mirror_version).toBeGreaterThan(0);
    expect(Array.isArray(body.deletions)).toBe(true);
  });
});
