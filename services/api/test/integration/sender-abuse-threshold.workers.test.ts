// W2c — pool-workers integration test for the escalating sender-abuse
// threshold cron. Verifies the permanent-memory rule: tier advances on each
// fire and NEVER resets across expirations or manual unsuppressions.
//
// Tests:
//   * tier-0 sender: 4 events in 24h does NOT fire (under 5 threshold)
//   * adding a 5th event fires with 24h suppression + current_tier=1
//   * subsequent 4 events fires at tier-1 threshold with 7d suppression
//     + current_tier=2 (escalation: shorter trigger, longer duration)
//   * critical bypass: a single phishing_report fires regardless of count
//   * tier-5 (permanent): cron is a no-op
//   * idempotent: re-running the cron without new events doesn't fire again
//   * mailbox scope uses 3× threshold; domain scope uses 10×
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { senderAbuseThresholdRun } from '../../src/scheduled/sender-abuse-threshold.js';
import type { Env } from '../../src/env.js';

interface TestEnv extends Env {
  DB: D1Database;
}
const testEnv = env as unknown as TestEnv;

async function insertEvent(opts: {
  principal_type: 'sender_address' | 'mailbox' | 'domain';
  principal_id: string;
  classification?: string;
  weight?: number;
  reportedAt?: number;
}): Promise<void> {
  const reportedAtIso = new Date(opts.reportedAt ?? Date.now()).toISOString();
  const cols: Record<string, unknown> = {
    id: `evt-${Math.random()}-${Date.now()}`,
    sender_address: opts.principal_type === 'sender_address' ? opts.principal_id : null,
    sender_principal_mailbox_id: opts.principal_type === 'mailbox' ? opts.principal_id : null,
    sender_principal_sender_id: null,
    sender_principal_domain_id: opts.principal_type === 'domain' ? opts.principal_id : null,
    classification: opts.classification ?? 'spam_complaint',
    source: 'arf_inbox',
    source_ref: null,
    weight: opts.weight ?? 1,
    reporter_address: null,
    reporter_org: null,
    original_message_id: null,
    raw_meta: '{}',
    caused_suppression_id: null,
    reported_at: reportedAtIso,
    created_at: reportedAtIso,
  };
  await testEnv.DB.prepare(
    `INSERT INTO abuse_events (id, sender_address, sender_principal_mailbox_id,
       sender_principal_sender_id, sender_principal_domain_id, classification,
       source, source_ref, weight, reporter_address, reporter_org,
       original_message_id, raw_meta, caused_suppression_id, reported_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      cols.id,
      cols.sender_address,
      cols.sender_principal_mailbox_id,
      cols.sender_principal_sender_id,
      cols.sender_principal_domain_id,
      cols.classification,
      cols.source,
      cols.source_ref,
      cols.weight,
      cols.reporter_address,
      cols.reporter_org,
      cols.original_message_id,
      cols.raw_meta,
      cols.caused_suppression_id,
      cols.reported_at,
      cols.created_at,
    )
    .run();
}

beforeAll(async () => {
  const migrations = inject('migrations');
  await applyD1Migrations(testEnv.DB, migrations);
  const now = new Date().toISOString();
  // Seed parent rows so abuse_events FK constraints accept mailbox/domain
  // scope inserts.
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO zones (id, cf_zone_id, name, created_at) VALUES ('z1', 'cfz1', 'test.example', ?)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO mail_domains (id, zone_id, name, status, created_at, updated_at, verified_at)
       VALUES ('d1', 'z1', 'test.example', 'verified', ?, ?, ?)`,
    ).bind(now, now, now),
    testEnv.DB.prepare(
      `INSERT INTO mailboxes (id, name, created_at, updated_at) VALUES ('mb1', 'mb1-inbox', ?, ?)`,
    ).bind(now, now),
  ]);
});

beforeEach(async () => {
  await testEnv.DB.prepare(`DELETE FROM abuse_events`).run();
  await testEnv.DB.prepare(`DELETE FROM suppressions`).run();
  await testEnv.DB.prepare(`DELETE FROM sender_abuse_profile`).run();
  await testEnv.DB.prepare(`DELETE FROM admin_alerts`).run();
  // ALERT_WEBHOOK is a fake URL in test config; null it so sendAlert
  // doesn't try to fetch.
  delete (testEnv as { ALERT_WEBHOOK?: string }).ALERT_WEBHOOK;
});

describe('W2c — sender abuse threshold cron', () => {
  it('4 events at tier 0 does NOT fire (under threshold 5)', async () => {
    for (let i = 0; i < 4; i++) {
      await insertEvent({ principal_type: 'sender_address', principal_id: 'noisy@example.com' });
    }
    const r = await senderAbuseThresholdRun(testEnv as unknown as Env);
    expect(r.fired).toBe(0);
    const supp = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM suppressions`).first<{
      n: number;
    }>();
    expect(supp?.n).toBe(0);
  });

  it('5 events at tier 0 fires 24h suppression + advances to tier 1', async () => {
    for (let i = 0; i < 5; i++) {
      await insertEvent({ principal_type: 'sender_address', principal_id: 'spammy@example.com' });
    }
    const r = await senderAbuseThresholdRun(testEnv as unknown as Env);
    expect(r.fired).toBe(1);

    const supp = await testEnv.DB.prepare(
      `SELECT entity_type, scope, scope_target, reason, severity, expires_at
       FROM suppressions WHERE entity_type = 'sender' LIMIT 1`,
    ).first<{
      entity_type: string;
      scope: string;
      scope_target: string;
      reason: string;
      severity: string;
      expires_at: string | null;
    }>();
    expect(supp?.scope).toBe('sender_address');
    expect(supp?.scope_target).toBe('spammy@example.com');
    expect(supp?.reason).toBe('sender_abuse_threshold');
    expect(supp?.severity).toBe('critical');
    expect(supp?.expires_at).not.toBeNull();
    // ~24h ahead
    const expiresMs = Date.parse(supp!.expires_at!);
    const diffH = (expiresMs - Date.now()) / 3_600_000;
    expect(diffH).toBeGreaterThan(23);
    expect(diffH).toBeLessThan(25);

    const profile = await testEnv.DB.prepare(
      `SELECT current_tier, suppression_count, lifetime_event_count, lifetime_weighted_score
       FROM sender_abuse_profile WHERE principal_type = 'sender_address' AND principal_id = ?`,
    )
      .bind('spammy@example.com')
      .first<{
        current_tier: number;
        suppression_count: number;
        lifetime_event_count: number;
        lifetime_weighted_score: number;
      }>();
    expect(profile?.current_tier).toBe(1);
    expect(profile?.suppression_count).toBe(1);
    expect(profile?.lifetime_event_count).toBe(5);
    expect(profile?.lifetime_weighted_score).toBe(5);
  });

  it('escalation: tier-1 fires at 4 events with 7d duration → tier 2', async () => {
    // Pre-seed the profile at tier 1 (post-first-suppression state, after
    // its time-boxed suppression has expired).
    const now = new Date().toISOString();
    await testEnv.DB.prepare(
      `INSERT INTO sender_abuse_profile
         (principal_type, principal_id, lifetime_event_count, lifetime_weighted_score,
          suppression_count, current_tier, current_tier_started_at, last_suppressed_at,
          last_event_at, created_at, updated_at)
       VALUES ('sender_address', 'repeat@example.com', 5, 5, 1, 1, ?, ?, ?, ?, ?)`,
    )
      .bind(now, now, now, now, now)
      .run();

    // 4 fresh events — exactly tier-1 threshold.
    for (let i = 0; i < 4; i++) {
      await insertEvent({ principal_type: 'sender_address', principal_id: 'repeat@example.com' });
    }
    const r = await senderAbuseThresholdRun(testEnv as unknown as Env);
    expect(r.fired).toBe(1);

    const supp = await testEnv.DB.prepare(
      `SELECT expires_at FROM suppressions WHERE scope_target = ? AND disabled_at IS NULL`,
    )
      .bind('repeat@example.com')
      .first<{ expires_at: string }>();
    expect(supp?.expires_at).toBeTruthy();
    const diffD = (Date.parse(supp!.expires_at) - Date.now()) / (24 * 3_600_000);
    expect(diffD).toBeGreaterThan(6.5);
    expect(diffD).toBeLessThan(7.5);

    const profile = await testEnv.DB.prepare(
      `SELECT current_tier, suppression_count FROM sender_abuse_profile WHERE principal_id = ?`,
    )
      .bind('repeat@example.com')
      .first<{ current_tier: number; suppression_count: number }>();
    expect(profile?.current_tier).toBe(2);
    expect(profile?.suppression_count).toBe(2);
  });

  it('critical bypass: 1 phishing_report fires at tier 0 even though count < 5', async () => {
    await insertEvent({
      principal_type: 'sender_address',
      principal_id: 'phisher@example.com',
      classification: 'phishing_report',
      weight: 5,
    });
    const r = await senderAbuseThresholdRun(testEnv as unknown as Env);
    expect(r.fired).toBe(1);
    const profile = await testEnv.DB.prepare(
      `SELECT current_tier FROM sender_abuse_profile WHERE principal_id = ?`,
    )
      .bind('phisher@example.com')
      .first<{ current_tier: number }>();
    expect(profile?.current_tier).toBe(1);
  });

  it('tier 5 is permanent — cron no-op even with new events', async () => {
    const now = new Date().toISOString();
    await testEnv.DB.prepare(
      `INSERT INTO sender_abuse_profile
         (principal_type, principal_id, lifetime_event_count, lifetime_weighted_score,
          suppression_count, current_tier, current_tier_started_at, last_suppressed_at,
          last_event_at, created_at, updated_at)
       VALUES ('sender_address', 'banned@example.com', 100, 100, 5, 5, ?, ?, ?, ?, ?)`,
    )
      .bind(now, now, now, now, now)
      .run();
    for (let i = 0; i < 20; i++) {
      await insertEvent({ principal_type: 'sender_address', principal_id: 'banned@example.com' });
    }
    const r = await senderAbuseThresholdRun(testEnv as unknown as Env);
    expect(r.fired).toBe(0);
  });

  it('idempotent: re-running with no new events does not fire again', async () => {
    for (let i = 0; i < 5; i++) {
      await insertEvent({ principal_type: 'sender_address', principal_id: 'twice@example.com' });
    }
    const r1 = await senderAbuseThresholdRun(testEnv as unknown as Env);
    expect(r1.fired).toBe(1);
    const r2 = await senderAbuseThresholdRun(testEnv as unknown as Env);
    expect(r2.fired).toBe(0);
  });

  it('mailbox scope uses 3× threshold (15 events to fire at tier 0)', async () => {
    // 14 events: should not fire.
    for (let i = 0; i < 14; i++) {
      await insertEvent({ principal_type: 'mailbox', principal_id: 'mb1' });
    }
    const r1 = await senderAbuseThresholdRun(testEnv as unknown as Env);
    expect(r1.fired).toBe(0);
    // One more: 15 total → fires.
    await insertEvent({ principal_type: 'mailbox', principal_id: 'mb1' });
    const r2 = await senderAbuseThresholdRun(testEnv as unknown as Env);
    expect(r2.fired).toBe(1);
  });

  it('domain scope uses 10× threshold (50 events to fire at tier 0)', async () => {
    for (let i = 0; i < 49; i++) {
      await insertEvent({ principal_type: 'domain', principal_id: 'd1' });
    }
    const r1 = await senderAbuseThresholdRun(testEnv as unknown as Env);
    expect(r1.fired).toBe(0);
    await insertEvent({ principal_type: 'domain', principal_id: 'd1' });
    const r2 = await senderAbuseThresholdRun(testEnv as unknown as Env);
    expect(r2.fired).toBe(1);
  });
});
