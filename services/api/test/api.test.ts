import { describe, expect, it } from 'vitest';
import app from '../src/index.js';
import { mkEnv } from './mocks.js';
import { sign, generateNonce } from '@polaris-email/hmac';

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
  // POST /admin/bootstrap signed with POLARIS_SECRET_A
  const body = '{}';
  const req = await signedRequest(
    'https://polaris-email-api.workers.dev/admin/bootstrap',
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
  const j = (await res.json()) as { admin_key_id: string; admin_key_secret: string };
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
  it('issues an admin key once', async () => {
    const { env, admin } = await bootstrapEnv();
    expect(admin.admin_key_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(admin.admin_key_secret).toMatch(/^[0-9A-Z]+$/);

    // Second call should 409
    const req = await signedRequest(
      'https://polaris-email-api.workers.dev/admin/bootstrap',
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
    const req = new Request('https://polaris-email-api.workers.dev/admin/bootstrap', {
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

describe('admin api-keys', () => {
  it('issues a service-scoped key and uses it', async () => {
    const { env, admin } = await bootstrapEnv();

    // Create service
    let body = JSON.stringify({ id: 'expresscharge', name: 'ExpressCharge' });
    let req = await signedRequest(
      'https://x/v1/admin/services',
      body,
      'POST',
      admin.admin_key_secret,
      admin.admin_key_id,
    );
    let res = await app.fetch(req, env, ctx);
    expect(res.status).toBe(201);

    // Create domain (verified)
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO domains (name, direction, binding_name, verified_at, last_verify_check_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind('example.com', 'out', 'EMAIL_NOREPLY', now, now)
      .run();

    // Issue api key
    body = JSON.stringify({
      service_id: 'expresscharge',
      sender_scopes: [{ kind: 'exact', pattern: 'noreply@example.com' }],
      scopes: ['send'],
    });
    req = await signedRequest(
      'https://x/v1/admin/api-keys',
      body,
      'POST',
      admin.admin_key_secret,
      admin.admin_key_id,
    );
    res = await app.fetch(req, env, ctx);
    expect(res.status).toBe(201);
    const issued = (await res.json()) as { key_id: string; key_secret: string };

    // Send a message with the new key
    body = JSON.stringify({
      from: 'noreply@example.com',
      to: ['user@external.com'],
      subject: 'hi',
      text: 'hello',
      category: 'svc.test',
    });
    req = await signedRequest(
      'https://x/v1/messages',
      body,
      'POST',
      issued.key_secret,
      issued.key_id,
    );
    res = await app.fetch(req, env, ctx);
    expect(res.status).toBe(202);
    const sent = (await res.json()) as { messageId: string; queuedAt: number; mode: string };
    expect(sent.messageId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(sent.mode).toBe('live');
  });

  it('rejects from outside sender_scopes', async () => {
    const { env, admin } = await bootstrapEnv();
    // Service
    await app.fetch(
      await signedRequest(
        'https://x/v1/admin/services',
        JSON.stringify({ id: 'svc', name: 'Svc' }),
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    // Domain
    await env.DB.prepare(
      `INSERT INTO domains (name, direction, binding_name, verified_at, last_verify_check_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind('example.com', 'out', 'EMAIL_NOREPLY', Date.now(), Date.now())
      .run();
    // Issue key scoped to noreply@
    const issueRes = await app.fetch(
      await signedRequest(
        'https://x/v1/admin/api-keys',
        JSON.stringify({
          service_id: 'svc',
          sender_scopes: [{ kind: 'exact', pattern: 'noreply@example.com' }],
        }),
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    const issued = (await issueRes.json()) as { key_id: string; key_secret: string };
    // Send as someone else
    const res = await app.fetch(
      await signedRequest(
        'https://x/v1/messages',
        JSON.stringify({
          from: 'ceo@example.com',
          to: ['x@y.com'],
          subject: 'spoof',
          text: 'no',
          category: 'svc.test',
        }),
        'POST',
        issued.key_secret,
        issued.key_id,
      ),
      env,
      ctx,
    );
    expect(res.status).toBe(403);
    const j = (await res.json()) as { error: { code: string } };
    expect(j.error.code).toBe('scope_violation');
  });

  it('idempotent replay returns original messageId without re-queueing', async () => {
    const { env, admin } = await bootstrapEnv();
    await app.fetch(
      await signedRequest(
        'https://x/v1/admin/services',
        JSON.stringify({ id: 'svc', name: 'Svc' }),
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    await env.DB.prepare(
      `INSERT INTO domains (name, direction, binding_name, verified_at, last_verify_check_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind('example.com', 'out', 'EMAIL_NOREPLY', Date.now(), Date.now())
      .run();
    const issueRes = await app.fetch(
      await signedRequest(
        'https://x/v1/admin/api-keys',
        JSON.stringify({
          service_id: 'svc',
          sender_scopes: [{ kind: 'exact', pattern: 'a@example.com' }],
        }),
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    const issued = (await issueRes.json()) as { key_id: string; key_secret: string };
    const body = JSON.stringify({
      from: 'a@example.com',
      to: ['b@x.com'],
      subject: 's',
      text: 't',
      category: 'svc.c',
    });
    const idem = 'idem-' + 'k'.repeat(20);
    const r1 = await app.fetch(
      await signedRequest('https://x/v1/messages', body, 'POST', issued.key_secret, issued.key_id, {
        'idempotency-key': idem,
      }),
      env,
      ctx,
    );
    expect(r1.status).toBe(202);
    const j1 = (await r1.json()) as { messageId: string };
    const r2 = await app.fetch(
      await signedRequest('https://x/v1/messages', body, 'POST', issued.key_secret, issued.key_id, {
        'idempotency-key': idem,
      }),
      env,
      ctx,
    );
    expect(r2.status).toBe(202);
    expect(r2.headers.get('x-polaris-idempotent')).toBe('replay');
    const j2 = (await r2.json()) as { messageId: string };
    expect(j2.messageId).toBe(j1.messageId);
  });

  it('idempotency conflict on body change', async () => {
    const { env, admin } = await bootstrapEnv();
    await app.fetch(
      await signedRequest(
        'https://x/v1/admin/services',
        JSON.stringify({ id: 'svc', name: 'Svc' }),
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    await env.DB.prepare(
      `INSERT INTO domains (name, direction, binding_name, verified_at, last_verify_check_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind('example.com', 'out', 'EMAIL_NOREPLY', Date.now(), Date.now())
      .run();
    const issued = (await (
      await app.fetch(
        await signedRequest(
          'https://x/v1/admin/api-keys',
          JSON.stringify({
            service_id: 'svc',
            sender_scopes: [{ kind: 'exact', pattern: 'a@example.com' }],
          }),
          'POST',
          admin.admin_key_secret,
          admin.admin_key_id,
        ),
        env,
        ctx,
      )
    ).json()) as { key_id: string; key_secret: string };
    const idem = 'idem-' + 'k'.repeat(20);
    const b1 = JSON.stringify({
      from: 'a@example.com',
      to: ['b@x.com'],
      subject: 's',
      text: 't',
      category: 'svc.c',
    });
    const b2 = JSON.stringify({
      from: 'a@example.com',
      to: ['b@x.com'],
      subject: 's2',
      text: 't',
      category: 'svc.c',
    });
    await app.fetch(
      await signedRequest('https://x/v1/messages', b1, 'POST', issued.key_secret, issued.key_id, {
        'idempotency-key': idem,
      }),
      env,
      ctx,
    );
    const r = await app.fetch(
      await signedRequest('https://x/v1/messages', b2, 'POST', issued.key_secret, issued.key_id, {
        'idempotency-key': idem,
      }),
      env,
      ctx,
    );
    expect(r.status).toBe(409);
  });

  it('rotation does not leak secret on idem replay', async () => {
    const { env, admin } = await bootstrapEnv();
    await app.fetch(
      await signedRequest(
        'https://x/v1/admin/services',
        JSON.stringify({ id: 'svc', name: 'Svc' }),
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    const issued = (await (
      await app.fetch(
        await signedRequest(
          'https://x/v1/admin/api-keys',
          JSON.stringify({
            service_id: 'svc',
            sender_scopes: [{ kind: 'exact', pattern: 'a@example.com' }],
          }),
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
    await app.fetch(
      await signedRequest(
        'https://x/v1/admin/services',
        JSON.stringify({ id: 'svc', name: 'Svc' }),
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    await env.DB.prepare(
      `INSERT INTO domains (name, direction, binding_name, verified_at, last_verify_check_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind('example.com', 'out', 'EMAIL_NOREPLY', Date.now(), Date.now())
      .run();
    const issued = (await (
      await app.fetch(
        await signedRequest(
          'https://x/v1/admin/api-keys',
          JSON.stringify({
            service_id: 'svc',
            sender_scopes: [{ kind: 'exact', pattern: 'a@example.com' }],
          }),
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
    const sendRes = await app.fetch(
      await signedRequest(
        'https://x/v1/messages',
        JSON.stringify({
          from: 'a@example.com',
          to: ['b@x.com'],
          subject: 's',
          text: 't',
          category: 'svc.c',
        }),
        'POST',
        issued.key_secret,
        issued.key_id,
      ),
      env,
      ctx,
    );
    expect(sendRes.status).toBe(403);
  });
});

describe('webhook subs', () => {
  it('rejects external http (must be https)', async () => {
    const { env, admin } = await bootstrapEnv();
    const res = await app.fetch(
      await signedRequest(
        'https://x/v1/admin/webhook-subs',
        JSON.stringify({
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
    const res = await app.fetch(
      await signedRequest(
        'https://x/v1/admin/webhook-subs',
        JSON.stringify({
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

describe('outbound_domains + senders', () => {
  it('full create→sender→smtp-credential flow', async () => {
    const { env, admin } = await bootstrapEnv();

    // Create outbound domain
    let res = await app.fetch(
      await signedRequest(
        'https://x/v1/admin/outbound-domains',
        JSON.stringify({ domain: 'plrs.im', is_default: true }),
        'POST',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    expect(res.status).toBe(201);
    const dom = (await res.json()) as { id: string; binding_tag: string; status: string };
    expect(dom.binding_tag).toBe('PLRS_IM');
    expect(dom.status).toBe('pending');

    // Duplicate → 409
    res = await app.fetch(
      await signedRequest(
        'https://x/v1/admin/outbound-domains',
        JSON.stringify({ domain: 'plrs.im' }),
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
        'https://x/v1/admin/outbound-domains',
        '',
        'GET',
        admin.admin_key_secret,
        admin.admin_key_id,
      ),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const list = (await res.json()) as { data: { domain: string; is_default: number }[] };
    expect(list.data[0]?.domain).toBe('plrs.im');
    expect(list.data[0]?.is_default).toBe(1);

    // Add sender
    res = await app.fetch(
      await signedRequest(
        `https://x/v1/admin/outbound-domains/${dom.id}/senders`,
        JSON.stringify({ local_part: 'noreply', default_for_domain: true }),
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

    // Issuing the credential must persist a smtp_credentials row with the
    // password_hash (NOT the plaintext) — the daemon polls /v1/bridge/config
    // and mirrors the hash locally. The plaintext is returned to the caller
    // in the response exactly once and never stored anywhere queryable.
    const mockDb = env.DB as unknown as { tables: Map<string, Record<string, unknown>[]> };
    const credRows = mockDb.tables.get('smtp_credentials') ?? [];
    const credRow = credRows.find((r) => r['username'] === 'noreply@plrs.im');
    expect(credRow).toBeTruthy();
    expect(credRow?.['id']).toBe(cred.id);
    expect(typeof credRow?.['password_hash']).toBe('string');
    expect(credRow?.['password_hash']).not.toBe(cred.secret);
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
        `https://x/v1/admin/outbound-domains/${dom.id}/verify`,
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
