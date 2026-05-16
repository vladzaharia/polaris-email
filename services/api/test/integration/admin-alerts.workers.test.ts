// W2d — pool-workers integration test for the admin alert pipeline.
//
// Drives `sendAlert()` directly so we can probe dedupe behaviour without
// needing to stand up the panel proxy. Asserts:
//   * admin_alerts row appears with severity/type/target/subject
//   * audit_log gets a `admin.alert.sent` row
//   * second call within the same hourly bucket gets `deduped=true`
//   * a different `target` does NOT dedupe (independent key)
//   * KV_ADMIN_ALERTS absence falls through (no crash; every call fires)
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { sendAlert } from '../../src/lib/admin-alert.js';

interface TestEnv {
  DB: D1Database;
  ALERT_WEBHOOK?: string;
  KV_ADMIN_ALERTS?: KVNamespace;
}
const testEnv = env as unknown as TestEnv;

beforeAll(async () => {
  const migrations = inject('migrations');
  await applyD1Migrations(testEnv.DB, migrations);
});

beforeEach(async () => {
  await testEnv.DB.prepare(`DELETE FROM admin_alerts`).run();
  delete (testEnv as { KV_ADMIN_ALERTS?: KVNamespace }).KV_ADMIN_ALERTS;
  // wrangler.test.jsonc declares ALERT_WEBHOOK as a placeholder URL that
  // doesn't resolve; null it out so the webhook channel falls through.
  // The abort timeout in sendAlert is a backstop but failing fast here is
  // cleaner for test introspection.
  delete (testEnv as { ALERT_WEBHOOK?: string }).ALERT_WEBHOOK;
});

describe('W2d — admin alert pipeline', () => {
  it('writes admin_alerts + audit_log on first fire', async () => {
    const r = await sendAlert(testEnv as unknown as Parameters<typeof sendAlert>[0], {
      alert_type: 'sender_suppressed',
      severity: 'critical',
      target: 'sender:foo@example.com',
      subject: '[POLARIS][CRITICAL] sender suppressed: foo@example.com',
      body: 'phishing_report threshold breached',
      payload: { suppression_id: '01HXTEST00000000000000000' },
    });
    expect(r.id).toBeTruthy();
    expect(r.deduped).toBe(false);

    const row = await testEnv.DB.prepare(
      `SELECT alert_type, severity, target, subject, payload FROM admin_alerts WHERE id = ?`,
    )
      .bind(r.id)
      .first<{
        alert_type: string;
        severity: string;
        target: string;
        subject: string;
        payload: string;
      }>();
    expect(row?.alert_type).toBe('sender_suppressed');
    expect(row?.severity).toBe('critical');
    expect(row?.target).toBe('sender:foo@example.com');
    expect(JSON.parse(row!.payload)).toMatchObject({
      suppression_id: '01HXTEST00000000000000000',
      deduped: false,
    });

    const audit = await testEnv.DB.prepare(
      `SELECT action, target FROM audit_log WHERE action = 'admin.alert.sent' ORDER BY id DESC LIMIT 1`,
    ).first<{ action: string; target: string }>();
    expect(audit?.action).toBe('admin.alert.sent');
    expect(audit?.target).toBe('sender:foo@example.com');
  });

  it('dedupes a second call within the same hourly bucket when KV is configured', async () => {
    // Stand up a stub KV namespace that mimics get/put for this test.
    const store = new Map<string, string>();
    const fakeKV = {
      async get(k: string) {
        return store.get(k) ?? null;
      },
      async put(k: string, v: string) {
        store.set(k, v);
      },
    } as unknown as KVNamespace;
    (testEnv as { KV_ADMIN_ALERTS?: KVNamespace }).KV_ADMIN_ALERTS = fakeKV;

    const first = await sendAlert(testEnv as unknown as Parameters<typeof sendAlert>[0], {
      alert_type: 'sender_suppressed',
      severity: 'critical',
      target: 'sender:dup@example.com',
      subject: 'first',
      body: 'first',
    });
    expect(first.deduped).toBe(false);

    const second = await sendAlert(testEnv as unknown as Parameters<typeof sendAlert>[0], {
      alert_type: 'sender_suppressed',
      severity: 'critical',
      target: 'sender:dup@example.com',
      subject: 'second',
      body: 'second',
    });
    expect(second.deduped).toBe(true);

    // Different target → distinct dedupe key → not deduped.
    const third = await sendAlert(testEnv as unknown as Parameters<typeof sendAlert>[0], {
      alert_type: 'sender_suppressed',
      severity: 'critical',
      target: 'sender:other@example.com',
      subject: 'other',
      body: 'other',
    });
    expect(third.deduped).toBe(false);

    // All three should be in admin_alerts (including the deduped one).
    const count = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM admin_alerts`).first<{
      n: number;
    }>();
    expect(count?.n).toBe(3);
  });

  it('falls through cleanly when KV_ADMIN_ALERTS is absent (every call fires)', async () => {
    const r1 = await sendAlert(testEnv as unknown as Parameters<typeof sendAlert>[0], {
      alert_type: 'manual',
      severity: 'info',
      target: 'no-kv-target',
      subject: 's',
      body: 'b',
    });
    const r2 = await sendAlert(testEnv as unknown as Parameters<typeof sendAlert>[0], {
      alert_type: 'manual',
      severity: 'info',
      target: 'no-kv-target',
      subject: 's',
      body: 'b',
    });
    expect(r1.deduped).toBe(false);
    expect(r2.deduped).toBe(false);
  });
});
