// Pool-workers integration test for the admin_alerts dismissal surface.
//
// Covers:
//   * `GET /v1/admin/alerts` defaults to dismissed_at IS NULL (hides dismissed).
//   * `?include_dismissed=1` re-exposes the full ledger.
//   * `POST /v1/admin/alerts/:id/dismiss` marks one row, idempotent on replay.
//   * `POST /v1/admin/alerts/dismiss` bulk-applies the same filter shape the
//     list endpoint uses (alert_type/severity/target/since) and reports the
//     number of rows changed.
//   * Bulk dismissal only affects still-active rows (touching a dismissed
//     row a second time is a no-op for that row).
//
// Alerts are seeded by direct INSERT (the table has no chain invariant; the
// audit ledger does, but the dismiss handlers drive their own audit writes
// through the real `audit()` helper which keeps that chain intact).
import { applyD1Migrations, createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { sign, generateNonce } from '@polaris-mail/hmac';
import worker from '../../src/index.js';
import type { Env } from '../../src/env.js';

interface TestEnv extends Env {
  DB: D1Database;
}
const testEnv = env as unknown as TestEnv;

const POLARIS_SECRET = 'phase-alerts-control-plane-secret';
const ARGON2_PEPPER = 'phase-alerts-pepper';

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
  };
  if (keyId) headers['x-polaris-key-id'] = keyId;
  return new Request(url, { method, headers, body: method === 'GET' ? undefined : body });
}

async function callWorker(req: Request): Promise<Response> {
  return worker.fetch(req, testEnv as unknown as Env, createExecutionContext());
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
  if (res.status !== 200) throw new Error(`bootstrap failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as BootstrapResult;
}

async function adminGet<T>(
  path: string,
  admin: BootstrapResult,
): Promise<{ status: number; body: T }> {
  const res = await callWorker(
    await signedRequest(`https://x${path}`, '', 'GET', admin.admin_key_secret, admin.admin_key_id),
  );
  const body = (await res.json()) as T;
  return { status: res.status, body };
}

async function adminPost<T>(
  path: string,
  body: object,
  admin: BootstrapResult,
): Promise<{ status: number; body: T }> {
  const json = JSON.stringify(body);
  const res = await callWorker(
    await signedRequest(
      `https://x${path}`,
      json,
      'POST',
      admin.admin_key_secret,
      admin.admin_key_id,
    ),
  );
  const respBody = (await res.json()) as T;
  return { status: res.status, body: respBody };
}

let admin: BootstrapResult;
let seq = 0;

async function seedAlert(opts: {
  alertType: string;
  severity?: 'info' | 'warn' | 'critical';
  target?: string;
  dismissed?: boolean;
}): Promise<string> {
  seq += 1;
  const id = `01HXALERT${String(seq).padStart(17, '0')}`.slice(0, 26);
  const nowIso = new Date().toISOString();
  await testEnv.DB.prepare(
    `INSERT INTO admin_alerts
       (id, alert_type, severity, target, subject, body, delivery, payload,
        dedupe_key, created_at, dismissed_at)
     VALUES (?, ?, ?, ?, ?, ?, '[]', '{}', ?, ?, ?)`,
  )
    .bind(
      id,
      opts.alertType,
      opts.severity ?? 'warn',
      opts.target ?? `target-${seq}`,
      `subject-${seq}`,
      `body-${seq}`,
      `dedupe-${seq}`,
      nowIso,
      opts.dismissed ? nowIso : null,
    )
    .run();
  return id;
}

beforeAll(async () => {
  const migrations = inject('migrations');
  await applyD1Migrations(testEnv.DB, migrations);
  (testEnv as unknown as Record<string, unknown>).POLARIS_SECRET_A = POLARIS_SECRET;
  (testEnv as unknown as Record<string, unknown>).ARGON2_PEPPER = ARGON2_PEPPER;
  admin = await bootstrap();
});

interface AlertListBody {
  data: Array<{ id: string; dismissed_at: string | null }>;
}

describe('GET /v1/admin/alerts', () => {
  it('hides dismissed rows by default and exposes them via include_dismissed=1', async () => {
    const active = await seedAlert({ alertType: 'manual', severity: 'info' });
    const dismissed = await seedAlert({ alertType: 'manual', severity: 'info', dismissed: true });

    const def = await adminGet<AlertListBody>('/v1/admin/alerts?alert_type=manual', admin);
    expect(def.status).toBe(200);
    const defIds = def.body.data.map((r) => r.id);
    expect(defIds).toContain(active);
    expect(defIds).not.toContain(dismissed);

    const all = await adminGet<AlertListBody>(
      '/v1/admin/alerts?alert_type=manual&include_dismissed=1',
      admin,
    );
    const allIds = all.body.data.map((r) => r.id);
    expect(allIds).toContain(active);
    expect(allIds).toContain(dismissed);
  });
});

describe('POST /v1/admin/alerts/:id/dismiss', () => {
  it('marks a single row dismissed and is idempotent on replay', async () => {
    const id = await seedAlert({ alertType: 'synthetic_check_failed', severity: 'warn' });
    const first = await adminPost<{
      dismissed_at: string | null;
      dismissed_by: string | null;
      already_dismissed: boolean;
    }>(`/v1/admin/alerts/${id}/dismiss`, {}, admin);
    expect(first.status).toBe(200);
    expect(first.body.dismissed_at).toBeTruthy();
    expect(first.body.dismissed_by).toBeTruthy();
    expect(first.body.already_dismissed).toBe(false);

    // Replay returns 200 + already_dismissed=true; doesn't bump dismissed_at.
    const replay = await adminPost<{
      dismissed_at: string | null;
      already_dismissed: boolean;
    }>(`/v1/admin/alerts/${id}/dismiss`, {}, admin);
    expect(replay.status).toBe(200);
    expect(replay.body.already_dismissed).toBe(true);
    expect(replay.body.dismissed_at).toBe(first.body.dismissed_at);

    // Default list omits it now.
    const def = await adminGet<AlertListBody>(
      '/v1/admin/alerts?alert_type=synthetic_check_failed',
      admin,
    );
    expect(def.body.data.map((r) => r.id)).not.toContain(id);

    // An audit row records the dismissal.
    const auditCount = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'admin.alert.dismiss' AND target = ?`,
    )
      .bind(id)
      .first<{ n: number }>();
    expect(auditCount?.n).toBe(1);
  });

  it('404s for an unknown id', async () => {
    const r = await adminPost<{ error?: { code: string } }>(
      '/v1/admin/alerts/01HXALERT00000000000NONE00/dismiss',
      {},
      admin,
    );
    expect(r.status).toBe(404);
  });
});

describe('POST /v1/admin/alerts/dismiss', () => {
  it('dismisses every active row matching the filter; idempotent on replay', async () => {
    // Seed three rows: two we want to bulk-dismiss, one we want to leave alone.
    const a = await seedAlert({ alertType: 'tls_rpt_failure_burst', severity: 'warn' });
    const b = await seedAlert({ alertType: 'tls_rpt_failure_burst', severity: 'warn' });
    const c = await seedAlert({ alertType: 'tls_rpt_failure_burst', severity: 'critical' });

    const first = await adminPost<{ dismissed: number }>(
      '/v1/admin/alerts/dismiss',
      { alert_type: 'tls_rpt_failure_burst', severity: 'warn' },
      admin,
    );
    expect(first.status).toBe(200);
    expect(first.body.dismissed).toBe(2);

    // Replay finds nothing left to dismiss (active=0) for this filter.
    const replay = await adminPost<{ dismissed: number }>(
      '/v1/admin/alerts/dismiss',
      { alert_type: 'tls_rpt_failure_burst', severity: 'warn' },
      admin,
    );
    expect(replay.body.dismissed).toBe(0);

    // The critical row stays active.
    const defCritical = await adminGet<AlertListBody>(
      '/v1/admin/alerts?alert_type=tls_rpt_failure_burst&severity=critical',
      admin,
    );
    expect(defCritical.body.data.map((r) => r.id)).toContain(c);

    // Both warn rows are now dismissed in the ledger.
    const all = await adminGet<AlertListBody>(
      '/v1/admin/alerts?alert_type=tls_rpt_failure_burst&include_dismissed=1',
      admin,
    );
    const dismissedIds = all.body.data.filter((r) => r.dismissed_at !== null).map((r) => r.id);
    expect(dismissedIds).toContain(a);
    expect(dismissedIds).toContain(b);

    // Exactly one bulk-audit row was written (replay's zero-change call
    // intentionally skips the audit insert).
    const auditCount = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_log
        WHERE action = 'admin.alert.dismiss_bulk' AND target = 'admin_alerts'`,
    ).first<{ n: number }>();
    expect(auditCount?.n).toBe(1);
  });
});
