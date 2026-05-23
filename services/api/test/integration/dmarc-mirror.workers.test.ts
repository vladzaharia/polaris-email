import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { dmarcMirrorRun } from '../../src/scheduled/dmarc-mirror.js';
import type { Env } from '../../src/env.js';

interface TestEnv extends Env {
  DB: D1Database;
}
const testEnv = env as unknown as TestEnv;

async function seedDomain(id: string, name: string, zoneId: string): Promise<void> {
  const now = new Date().toISOString();
  await testEnv.DB.prepare(
    `INSERT INTO zones (id, cf_zone_id, name, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  )
    .bind('z_' + id, zoneId, name, now)
    .run();
  await testEnv.DB.prepare(
    `INSERT INTO mail_domains (id, zone_id, name, status, created_at, updated_at)
     VALUES (?, ?, ?, 'verified', ?, ?)`,
  )
    .bind(id, 'z_' + id, name, now, now)
    .run();
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, inject('migrations'));
});

beforeEach(async () => {
  await testEnv.DB.prepare(`DELETE FROM mail_domains`).run();
  await testEnv.DB.prepare(`DELETE FROM zones`).run();
  await testEnv.DB.prepare(`DELETE FROM dmarc_alignment_rollup`).run();
});

describe('dmarc-mirror', () => {
  it('upserts dmarc_alignment_rollup rows from CF GraphQL aggregates', async () => {
    await seedDomain('d1', 'good.example', 'cfz_x');

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toContain('/client/v4/graphql');
      const body = JSON.parse(init?.body as string);
      expect(body.variables.zoneTag).toBe('cfz_x');
      return new Response(
        JSON.stringify({
          data: {
            viewer: {
              zones: [
                {
                  dmarcReportsAdaptive: [
                    {
                      dimensions: { date: '2026-05-22', headerFrom: 'good.example' },
                      sum: {
                        totalCount: 100,
                        dmarcPassedCount: 99,
                        dkimPassedCount: 99,
                        spfPassedCount: 98,
                      },
                    },
                  ],
                },
              ],
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const r = await dmarcMirrorRun(testEnv as unknown as Env, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      apiToken: 'tkn',
      accountId: 'acct',
    });
    expect(r.zones).toBe(1);
    expect(r.rowsUpserted).toBe(1);

    const row = await testEnv.DB.prepare(
      `SELECT total_count, dmarc_pass, dkim_pass, spf_pass FROM dmarc_alignment_rollup
       WHERE domain = 'good.example' AND day = '2026-05-22'`,
    ).first<{ total_count: number; dmarc_pass: number; dkim_pass: number; spf_pass: number }>();
    expect(row).toEqual({ total_count: 100, dmarc_pass: 99, dkim_pass: 99, spf_pass: 98 });
  });

  it('returns empty when there are no verified outbound domains', async () => {
    const fetchMock = vi.fn();
    const r = await dmarcMirrorRun(testEnv as unknown as Env, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      apiToken: 'tkn',
      accountId: 'acct',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.zones).toBe(0);
    expect(r.rowsUpserted).toBe(0);
  });

  it('returns early when CF credentials are missing', async () => {
    await seedDomain('d1', 'good.example', 'cfz_x');
    const r = await dmarcMirrorRun(testEnv as unknown as Env, {
      apiToken: undefined,
      accountId: undefined,
    });
    expect(r.zones).toBe(0);
  });

  it('tolerates a single zone failing and surfaces it in the result', async () => {
    await seedDomain('d1', 'good.example', 'cfz_x');
    await seedDomain('d2', 'bad.example', 'cfz_y');

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      if (body.variables.zoneTag === 'cfz_y') {
        return new Response(JSON.stringify({ errors: [{ message: 'boom' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({ data: { viewer: { zones: [{ dmarcReportsAdaptive: [] }] } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const r = await dmarcMirrorRun(testEnv as unknown as Env, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      apiToken: 'tkn',
      accountId: 'acct',
    });
    expect(r.zones).toBe(2);
    expect(r.failed).toBe(1);
  });
});
