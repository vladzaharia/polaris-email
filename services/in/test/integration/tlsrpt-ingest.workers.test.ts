// W5 — pool-workers integration test for TLS-RPT ingest path.
//
// Builds a synthetic gzipped TLS-RPT report, wraps it in a
// `multipart/report; report-type=tlsrpt` MIME envelope, delivers it to the
// platform TLS-RPT mailbox via services/in, then asserts:
//   * tls_rpt_reports row landed with correct totals + policies_json
//   * tls_rpt_failure_summary rollup advanced for each result_type
//   * second delivery of the same report-id ADDS to the rollup (idempotency
//     is intentionally not enforced — multiple reports for the same window
//     are expected from different MUAs).
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import worker from '../../src/index.js';

interface TestEnv {
  DB: D1Database;
  R2: R2Bucket;
  KV_RATE_LIMIT: KVNamespace;
  FANOUT_QUEUE: Queue<unknown>;
}
const testEnv = env as unknown as TestEnv;

const PLATFORM_MAILBOX_ID = '01HXPLATFORMTLSREPORTS0000';

function mockMessage(opts: { to: string; from: string; raw: string }): ForwardableEmailMessage {
  let rejected: string | null = null;
  return {
    from: opts.from,
    to: opts.to,
    headers: new Headers(),
    raw: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(opts.raw));
        controller.close();
      },
    }),
    rawSize: opts.raw.length,
    setReject(reason: string) {
      rejected = reason;
    },
    async forward() {
      throw new Error('not expected');
    },
    async reply() {
      throw new Error('not expected');
    },
    get rejected() {
      return rejected;
    },
  } as unknown as ForwardableEmailMessage;
}

function buildSampleReport(domain: string, failures: number): unknown {
  return {
    'organization-name': 'Example ISP',
    'contact-info': 'tls-rpt@isp.example',
    'report-id': `2026-05-16T00:00:00Z_${domain}`,
    'date-range': {
      'start-datetime': '2026-05-15T00:00:00Z',
      'end-datetime': '2026-05-15T23:59:59Z',
    },
    policies: [
      {
        policy: { 'policy-type': 'sts', 'policy-domain': domain },
        summary: {
          'total-successful-session-count': 1000 - failures,
          'total-failure-session-count': failures,
        },
        'failure-details':
          failures > 0
            ? [
                {
                  'result-type': 'certificate-expired',
                  'failed-session-count': failures,
                },
              ]
            : [],
      },
    ],
  };
}

function buildMime(domain: string, failures: number): string {
  const gz = gzipSync(JSON.stringify(buildSampleReport(domain, failures)));
  const b64 = gz.toString('base64');
  // Re-wrap into 76-char lines per RFC 2045.
  const wrapped = b64.match(/.{1,76}/g)!.join('\r\n');
  return [
    'From: reporter@isp.example',
    'To: tlsrpt@plrs.im',
    'Subject: Report Domain: ' + domain,
    'Content-Type: multipart/report; report-type=tlsrpt; boundary="b1"',
    'MIME-Version: 1.0',
    '',
    '--b1',
    'Content-Type: text/plain',
    '',
    'Attached is a TLS-RPT report for ' + domain + '.',
    '--b1',
    'Content-Type: application/tlsrpt+gzip; name="report.gz"',
    'Content-Transfer-Encoding: base64',
    '',
    wrapped,
    '--b1--',
    '',
  ].join('\r\n');
}

beforeAll(async () => {
  const migrations = inject('migrations');
  await applyD1Migrations(testEnv.DB, migrations);
  const now = new Date().toISOString();
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO zones (id, cf_zone_id, name, created_at) VALUES ('z1', 'cfz1', 'plrs.im', ?)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO mail_domains (id, zone_id, name, status, created_at, updated_at, verified_at)
       VALUES ('plrs', 'z1', 'plrs.im', 'verified', ?, ?, ?)`,
    ).bind(now, now, now),
    // Receiver pointing tlsrpt@plrs.im at the platform mailbox.
    testEnv.DB.prepare(
      `INSERT INTO mailbox_receivers (id, mailbox_id, domain_id, priority,
         address_pattern, action, webhook_sub_id, forward_to, enabled, created_at, disabled_at)
       VALUES ('rcpt-tlsrpt', ?, 'plrs', 10, 'tlsrpt@*', 'webhook', NULL, NULL, 1, ?, NULL)`,
    ).bind(PLATFORM_MAILBOX_ID, now),
  ]);
});

beforeEach(async () => {
  await testEnv.DB.prepare(`DELETE FROM tls_rpt_reports`).run();
  await testEnv.DB.prepare(`DELETE FROM tls_rpt_failure_summary`).run();
});

describe('W5 — TLS-RPT ingest', () => {
  it('parses + persists a gzipped multipart report with failures', async () => {
    const msg = mockMessage({
      to: 'tlsrpt@plrs.im',
      from: 'reporter@isp.example',
      raw: buildMime('mail.example.com', 7),
    });
    await worker.email!(msg, testEnv as unknown as never, {} as ExecutionContext);

    const report = await testEnv.DB.prepare(
      `SELECT domain, total_success_count, total_failure_count, organization_name
       FROM tls_rpt_reports LIMIT 1`,
    ).first<{
      domain: string;
      total_success_count: number;
      total_failure_count: number;
      organization_name: string;
    }>();
    expect(report?.domain).toBe('mail.example.com');
    expect(report?.total_failure_count).toBe(7);
    expect(report?.total_success_count).toBe(993);
    expect(report?.organization_name).toBe('Example ISP');

    const summary = await testEnv.DB.prepare(
      `SELECT result_type, failed_sessions, reports FROM tls_rpt_failure_summary
       WHERE domain = 'mail.example.com'`,
    ).first<{ result_type: string; failed_sessions: number; reports: number }>();
    expect(summary?.result_type).toBe('certificate-expired');
    expect(summary?.failed_sessions).toBe(7);
    expect(summary?.reports).toBe(1);
  });

  it('second report ADDS to the rollup (no idempotency on rollup)', async () => {
    const msg1 = mockMessage({
      to: 'tlsrpt@plrs.im',
      from: 'reporter@isp.example',
      raw: buildMime('mail.example.com', 3),
    });
    await worker.email!(msg1, testEnv as unknown as never, {} as ExecutionContext);
    const msg2 = mockMessage({
      to: 'tlsrpt@plrs.im',
      from: 'reporter@isp.example',
      raw: buildMime('mail.example.com', 5),
    });
    await worker.email!(msg2, testEnv as unknown as never, {} as ExecutionContext);

    const summary = await testEnv.DB.prepare(
      `SELECT failed_sessions, reports FROM tls_rpt_failure_summary
       WHERE domain = 'mail.example.com' AND result_type = 'certificate-expired'`,
    ).first<{ failed_sessions: number; reports: number }>();
    expect(summary?.failed_sessions).toBe(8);
    expect(summary?.reports).toBe(2);
  });

  it('zero-failure report writes the row but no summary entries', async () => {
    const msg = mockMessage({
      to: 'tlsrpt@plrs.im',
      from: 'reporter@isp.example',
      raw: buildMime('clean.example', 0),
    });
    await worker.email!(msg, testEnv as unknown as never, {} as ExecutionContext);

    const report = await testEnv.DB.prepare(
      `SELECT total_failure_count FROM tls_rpt_reports WHERE domain = 'clean.example'`,
    ).first<{ total_failure_count: number }>();
    expect(report?.total_failure_count).toBe(0);

    const summaryCount = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM tls_rpt_failure_summary WHERE domain = 'clean.example'`,
    ).first<{ n: number }>();
    expect(summaryCount?.n).toBe(0);
  });
});
