// W11 — pool-workers integration test for the synthetic monitoring crons.
//
// Both checks talk to live DoH + HTTPS, but in the workerd test environment
// those external resolvers aren't reachable, so we assert the run-recording
// shape: candidates counted, synthetic_runs rows written, alerts dispatched
// when checks fail.
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { mtaStsContinuityRun } from '../../src/scheduled/mta-sts-continuity.js';
import { dkimSelfVerifyRun } from '../../src/scheduled/dkim-self-verify.js';
import type { Env } from '../../src/env.js';

interface TestEnv extends Env {
  DB: D1Database;
}
const testEnv = env as unknown as TestEnv;

beforeAll(async () => {
  const migrations = inject('migrations');
  await applyD1Migrations(testEnv.DB, migrations);
  const now = new Date().toISOString();
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO zones (id, cf_zone_id, name, created_at) VALUES ('z1', 'cfz1', 'test.example', ?)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO mailboxes (id, name, created_at, updated_at) VALUES ('mb1', 'inbox', ?, ?)`,
    ).bind(now, now),
  ]);
});

beforeEach(async () => {
  await testEnv.DB.prepare(`DELETE FROM synthetic_runs`).run();
  await testEnv.DB.prepare(`DELETE FROM admin_alerts`).run();
  await testEnv.DB.prepare(`DELETE FROM mail_domains`).run();
  delete (testEnv as { ALERT_WEBHOOK?: string }).ALERT_WEBHOOK;
});

describe('W11 — MTA-STS continuity cron', () => {
  it('no candidates when no domain is in enforce mode', async () => {
    const r = await mtaStsContinuityRun(testEnv as unknown as Env);
    expect(r.candidates).toBe(0);
    const rows = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM synthetic_runs`).first<{
      n: number;
    }>();
    expect(rows?.n).toBe(0);
  });

  it('records a failed run for an enforce-mode domain with no real DNS', async () => {
    const now = new Date().toISOString();
    await testEnv.DB.prepare(
      `INSERT INTO mail_domains (id, zone_id, name, status, mta_sts_mode, mta_sts_policy_id,
         created_at, updated_at, verified_at)
       VALUES ('d1', 'z1', 'mtasts.test.invalid', 'verified', 'enforce', '20260516T120000Z', ?, ?, ?)`,
    )
      .bind(now, now, now)
      .run();
    const r = await mtaStsContinuityRun(testEnv as unknown as Env);
    expect(r.candidates).toBe(1);
    // The DoH lookup will fail to resolve test.invalid so the run records failure.
    expect(r.ok + r.failed).toBe(1);
    const row = await testEnv.DB.prepare(
      `SELECT ok, check_kind FROM synthetic_runs ORDER BY run_at DESC LIMIT 1`,
    ).first<{ ok: number; check_kind: string }>();
    expect(row?.check_kind).toBe('mta_sts_continuity');
  });
});

describe('W11 — DKIM self-verify cron', () => {
  it('records a skipped run when cf-bounce subdomain does not resolve (sender not onboarded)', async () => {
    // `cf-bounce.<domain>` MX is the sender-onboarded gate — when it
    // resolves to nothing (the workerd test env has no DoH reachability,
    // so every lookup returns empty), the cron skips DKIM verification
    // and records the skip rather than alerting.
    const now = new Date().toISOString();
    await testEnv.DB.prepare(
      `INSERT INTO mail_domains (id, zone_id, name, status, outbound_enabled,
         dkim_selector, created_at, updated_at, verified_at)
       VALUES ('d2', 'z1', 'dkim.test.invalid', 'verified', 1, 'cf', ?, ?, ?)`,
    )
      .bind(now, now, now)
      .run();
    const r = await dkimSelfVerifyRun(testEnv as unknown as Env);
    expect(r.candidates).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.failed).toBe(0);
    const row = await testEnv.DB.prepare(
      `SELECT check_kind, target, detail, ok FROM synthetic_runs ORDER BY run_at DESC LIMIT 1`,
    ).first<{ check_kind: string; target: string; detail: string; ok: number }>();
    expect(row?.check_kind).toBe('dkim_self_verify');
    expect(row?.target).toBe('dkim.test.invalid');
    // Skipped runs intentionally record ok=1 so the diagnostics widget's
    // per-check_kind pass-rate isn't polluted by deliberate skips. The
    // detail.outcome distinction is preserved for drill-in.
    expect(row?.ok).toBe(1);
    const detail = JSON.parse(row!.detail) as { outcome: string; reason?: string };
    expect(detail.outcome).toBe('skipped');
    expect(detail.reason).toBe('sender_not_onboarded');
    // No admin_alert should fire on a skipped check.
    const alerts = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM admin_alerts`).first<{
      n: number;
    }>();
    expect(alerts?.n).toBe(0);
  });
});
