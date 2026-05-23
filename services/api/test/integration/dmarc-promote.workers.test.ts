// W8 — pool-workers integration test for the DMARC auto-promotion cron.
//
// Covers:
//   * tier-0 (none) → quarantine_ready after 14d of ≥99% alignment
//   * insufficient soak does not advance
//   * quarantine_ready → quarantine after cool-down elapses
//   * rollback: 24h pass < 95% pauses
//   * paused domains skip the cron entirely
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { dmarcPromoteRun } from '../../src/scheduled/dmarc-promote.js';
import type { Env } from '../../src/env.js';

interface TestEnv extends Env {
  DB: D1Database;
}
const testEnv = env as unknown as TestEnv;

async function seedDomain(opts: {
  id: string;
  name: string;
  state?: string;
  mode?: string;
  policy?: string;
  promotionLastAt?: string | null;
}): Promise<void> {
  const now = new Date().toISOString();
  await testEnv.DB.prepare(
    `INSERT INTO zones (id, cf_zone_id, name, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  )
    .bind('z_' + opts.id, 'cfz_' + opts.id, opts.name, now)
    .run();
  await testEnv.DB.prepare(
    `INSERT INTO mail_domains
       (id, zone_id, name, status, dmarc_policy, dmarc_promotion_mode,
        dmarc_promotion_state, dmarc_promotion_last_at, created_at, updated_at)
     VALUES (?, ?, ?, 'verified', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      opts.id,
      'z_' + opts.id,
      opts.name,
      opts.policy ?? 'none',
      opts.mode ?? 'auto',
      opts.state ?? 'none',
      opts.promotionLastAt ?? null,
      now,
      now,
    )
    .run();
}

async function seedRollupDays(domain: string, days: number, passPct: number): Promise<void> {
  const total = 200; // > MIN_DAILY_VOLUME so the cron considers the volume sufficient
  const dmarcPass = Math.floor(total * (passPct / 100));
  const nowIso = new Date().toISOString();
  for (let i = 0; i < days; i++) {
    const day = new Date(Date.now() - i * 24 * 3_600_000).toISOString().slice(0, 10);
    await testEnv.DB.prepare(
      `INSERT INTO dmarc_alignment_rollup
         (domain, day, reports, total_count, dmarc_pass, dkim_pass, spf_pass, last_seen_at)
       VALUES (?, ?, 5, ?, ?, ?, ?, ?)
       ON CONFLICT(domain, day) DO UPDATE SET
         reports = excluded.reports,
         total_count = excluded.total_count,
         dmarc_pass = excluded.dmarc_pass,
         dkim_pass = excluded.dkim_pass,
         spf_pass = excluded.spf_pass,
         last_seen_at = excluded.last_seen_at`,
    )
      .bind(domain, day, total, dmarcPass, dmarcPass, dmarcPass, nowIso)
      .run();
  }
}

beforeAll(async () => {
  const migrations = inject('migrations');
  await applyD1Migrations(testEnv.DB, migrations);
});

beforeEach(async () => {
  await testEnv.DB.prepare(`DELETE FROM mail_domains`).run();
  await testEnv.DB.prepare(`DELETE FROM zones`).run();
  await testEnv.DB.prepare(`DELETE FROM dmarc_alignment_rollup`).run();
  await testEnv.DB.prepare(`DELETE FROM admin_alerts`).run();
  delete (testEnv as { ALERT_WEBHOOK?: string }).ALERT_WEBHOOK;
});

describe('W8 — DMARC promotion cron', () => {
  it('advances none → quarantine_ready when soak passes', async () => {
    await seedDomain({ id: 'd1', name: 'good.example' });
    await seedRollupDays('good.example', 14, 99.5);
    const r = await dmarcPromoteRun(testEnv as unknown as Env);
    expect(r.promoted).toBe(1);
    const after = await testEnv.DB.prepare(
      `SELECT dmarc_promotion_state FROM mail_domains WHERE id = 'd1'`,
    ).first<{ dmarc_promotion_state: string }>();
    expect(after?.dmarc_promotion_state).toBe('quarantine_ready');
  });

  it('does not advance with insufficient soak', async () => {
    await seedDomain({ id: 'd2', name: 'short.example' });
    await seedRollupDays('short.example', 7, 99.5);
    const r = await dmarcPromoteRun(testEnv as unknown as Env);
    expect(r.promoted).toBe(0);
    expect(r.noOp).toBe(1);
  });

  it('cool-down: quarantine_ready → quarantine after 7d elapsed', async () => {
    const longAgo = new Date(Date.now() - 8 * 24 * 3_600_000).toISOString();
    await seedDomain({
      id: 'd3',
      name: 'cool.example',
      state: 'quarantine_ready',
      promotionLastAt: longAgo,
    });
    await seedRollupDays('cool.example', 14, 99.9);
    const r = await dmarcPromoteRun(testEnv as unknown as Env);
    expect(r.promoted).toBe(1);
    const after = await testEnv.DB.prepare(
      `SELECT dmarc_promotion_state FROM mail_domains WHERE id = 'd3'`,
    ).first<{ dmarc_promotion_state: string }>();
    expect(after?.dmarc_promotion_state).toBe('quarantine');
  });

  it('rollback: 24h alignment drop pauses', async () => {
    await seedDomain({
      id: 'd4',
      name: 'drop.example',
      state: 'quarantine',
    });
    await seedRollupDays('drop.example', 1, 80); // 80% < 95% rollback threshold
    const r = await dmarcPromoteRun(testEnv as unknown as Env);
    expect(r.paused).toBe(1);
    const after = await testEnv.DB.prepare(
      `SELECT dmarc_promotion_state FROM mail_domains WHERE id = 'd4'`,
    ).first<{ dmarc_promotion_state: string }>();
    expect(after?.dmarc_promotion_state).toBe('paused');
  });

  it('paused mode skips the cron', async () => {
    await seedDomain({ id: 'd5', name: 'paused.example', mode: 'paused' });
    await seedRollupDays('paused.example', 14, 99.9);
    const r = await dmarcPromoteRun(testEnv as unknown as Env);
    expect(r.candidates).toBe(0); // mode != 'auto' → excluded from the query
  });

  describe('CF DMARC Management policy publish', () => {
    let originalFetch: typeof fetch;
    beforeEach(() => {
      originalFetch = globalThis.fetch;
      (testEnv as TestEnv & { CF_API_TOKEN?: string; CF_ACCOUNT_ID?: string }).CF_API_TOKEN = 'tkn';
      (testEnv as TestEnv & { CF_API_TOKEN?: string; CF_ACCOUNT_ID?: string }).CF_ACCOUNT_ID =
        'acct';
    });
    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('calls setDmarcPolicy when auto-mode advances quarantine_ready → quarantine', async () => {
      const longAgo = new Date(Date.now() - 8 * 24 * 3_600_000).toISOString();
      await seedDomain({
        id: 'd6',
        name: 'cfcall.example',
        state: 'quarantine_ready',
        promotionLastAt: longAgo,
      });
      await seedRollupDays('cfcall.example', 14, 99.9);

      const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        expect(u).toContain('/zones/');
        expect(u).toContain('/dmarc_management');
        expect(init?.method).toBe('PATCH');
        return new Response(JSON.stringify({ success: true, result: { policy: 'quarantine' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const r = await dmarcPromoteRun(testEnv as unknown as Env);
      expect(r.promoted).toBe(1);
      expect(fetchMock).toHaveBeenCalled();
    });
  });
});
