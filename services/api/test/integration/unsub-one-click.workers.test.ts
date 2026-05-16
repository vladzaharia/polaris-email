// W4 — pool-workers integration test for the RFC 8058 one-click
// unsubscribe endpoint. Covers:
//   * valid POST → 200 + suppression row scoped to sender_domain
//   * invalid signature → 400 / bad_request, no suppression
//   * GET → HTML page with confirm form
//   * mint→verify→POST round-trip
//   * replay (same token twice) → 200 both times, no duplicate row
import { applyD1Migrations, createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import worker from '../../src/index.js';
import { buildUnsubHeaders, mintUnsubToken } from '../../src/lib/unsub-token.js';
import type { Env } from '../../src/env.js';

interface TestEnv extends Env {
  DB: D1Database;
}
const testEnv = env as unknown as TestEnv;
const UNSUB_HMAC_SECRET = 'phase-w4-unsub-test-secret';

beforeAll(async () => {
  const migrations = inject('migrations');
  await applyD1Migrations(testEnv.DB, migrations);
  (testEnv as { UNSUB_HMAC_SECRET?: string }).UNSUB_HMAC_SECRET = UNSUB_HMAC_SECRET;
});

beforeEach(async () => {
  await testEnv.DB.prepare(`DELETE FROM suppressions`).run();
});

async function callUnsub(method: string, token: string): Promise<Response> {
  const req = new Request(`https://x/v1/unsub/${encodeURIComponent(token)}`, { method });
  const ctx = createExecutionContext();
  return worker.fetch(req, testEnv as unknown as Env, ctx);
}

describe('W4 — one-click unsubscribe endpoint', () => {
  it('valid POST → 200 + recipient suppression scoped to sender_domain', async () => {
    const token = await mintUnsubToken(
      {
        recipient: 'user@gmail.com',
        sender_domain: 'newsletter.acme.example',
        message_id: '01HXW4MSG00000000000000000',
      },
      UNSUB_HMAC_SECRET,
    );
    const r = await callUnsub('POST', token);
    expect(r.status).toBe(200);

    const supp = await testEnv.DB.prepare(
      `SELECT entity_type, scope, scope_target, reason, source, address_normalized, severity
       FROM suppressions LIMIT 1`,
    ).first<{
      entity_type: string;
      scope: string;
      scope_target: string;
      reason: string;
      source: string;
      address_normalized: string;
      severity: string;
    }>();
    expect(supp?.entity_type).toBe('recipient');
    expect(supp?.scope).toBe('domain');
    expect(supp?.scope_target).toBe('newsletter.acme.example');
    expect(supp?.reason).toBe('unsubscribe');
    expect(supp?.source).toBe('one_click');
    expect(supp?.address_normalized).toBe('user@gmail.com');
    expect(supp?.severity).toBe('info');
  });

  it('GET → HTML page with confirm form', async () => {
    const token = await mintUnsubToken(
      {
        recipient: 'user@example.com',
        sender_domain: 'shop.example',
        message_id: '01HXW4MSG2000000000000000',
      },
      UNSUB_HMAC_SECRET,
    );
    const r = await callUnsub('GET', token);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain('Unsubscribe from shop.example');
    expect(body).toContain('user@example.com');
    expect(body).toContain('Confirm unsubscribe');
  });

  it('invalid signature → 400, no suppression', async () => {
    const r = await callUnsub('POST', 'not-a-valid-token');
    expect(r.status).toBe(400);
    const count = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM suppressions`).first<{
      n: number;
    }>();
    expect(count?.n).toBe(0);
  });

  it('replay (same token twice) → 200 both times, no duplicate row', async () => {
    const token = await mintUnsubToken(
      {
        recipient: 'replay@example.com',
        sender_domain: 'repeat.example',
        message_id: '01HXW4REPLAY00000000000000',
      },
      UNSUB_HMAC_SECRET,
    );
    const r1 = await callUnsub('POST', token);
    expect(r1.status).toBe(200);
    const r2 = await callUnsub('POST', token);
    expect(r2.status).toBe(200);
    const count = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM suppressions`).first<{
      n: number;
    }>();
    expect(count?.n).toBe(1);
  });

  it('buildUnsubHeaders produces RFC 8058-shaped headers for marketing stream', async () => {
    const headers = await buildUnsubHeaders(
      {
        recipient: 'someone@example.com',
        sender_domain: 'bulk.example',
        message_id: '01HXW4HEADERS000000000000',
      },
      UNSUB_HMAC_SECRET,
      'https://api.example.com',
      'plrs.im',
    );
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(headers['List-Unsubscribe']).toMatch(
      /^<mailto:unsub\+[^@>]+@plrs\.im>, <https:\/\/api\.example\.com\/v1\/unsub\/[^>]+>$/,
    );
  });
});
