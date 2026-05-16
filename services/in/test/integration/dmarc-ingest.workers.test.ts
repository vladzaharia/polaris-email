// W6 — pool-workers integration test for DMARC RUA ingest.
//
// Builds a synthetic gzipped DMARC XML report, wraps it in a multipart
// MIME envelope with application/gzip, delivers to the platform DMARC
// mailbox, then asserts:
//   * dmarc_aggregate_reports row landed with totals
//   * dmarc_alignment_rollup advanced for (domain, day)
//   * second delivery accumulates into the rollup
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

const PLATFORM_MAILBOX_ID = '01HXPLATFORMDMARCREPORTS00';

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

function sampleXml(domain: string, dkimPass: number, dkimFail: number): string {
  return `<?xml version="1.0"?>
<feedback>
  <report_metadata>
    <org_name>Example ISP</org_name>
    <email>noreply-dmarc@isp.example</email>
    <report_id>${domain}-${Date.now()}</report_id>
    <date_range>
      <begin>1747353600</begin>
      <end>1747440000</end>
    </date_range>
  </report_metadata>
  <policy_published>
    <domain>${domain}</domain>
    <adkim>r</adkim>
    <aspf>r</aspf>
    <p>none</p>
    <sp>none</sp>
    <pct>100</pct>
  </policy_published>
  <record>
    <row>
      <source_ip>203.0.113.5</source_ip>
      <count>${dkimPass}</count>
      <policy_evaluated>
        <disposition>none</disposition>
        <dkim>pass</dkim>
        <spf>pass</spf>
      </policy_evaluated>
    </row>
    <identifiers><header_from>${domain}</header_from></identifiers>
    <auth_results>
      <dkim><domain>${domain}</domain><result>pass</result></dkim>
      <spf><domain>${domain}</domain><result>pass</result></spf>
    </auth_results>
  </record>
  <record>
    <row>
      <source_ip>198.51.100.7</source_ip>
      <count>${dkimFail}</count>
      <policy_evaluated>
        <disposition>none</disposition>
        <dkim>fail</dkim>
        <spf>fail</spf>
      </policy_evaluated>
    </row>
    <identifiers><header_from>${domain}</header_from></identifiers>
    <auth_results>
      <dkim><domain>${domain}</domain><result>fail</result></dkim>
      <spf><domain>impostor.example</domain><result>fail</result></spf>
    </auth_results>
  </record>
</feedback>`;
}

function buildMime(domain: string, dkimPass: number, dkimFail: number): string {
  const gz = gzipSync(sampleXml(domain, dkimPass, dkimFail));
  const b64 = gz.toString('base64');
  const wrapped = b64.match(/.{1,76}/g)!.join('\r\n');
  return [
    'From: noreply-dmarc@isp.example',
    'To: dmarc-rua@plrs.im',
    'Subject: Report Domain: ' + domain,
    'Content-Type: multipart/mixed; boundary="d1"',
    'MIME-Version: 1.0',
    '',
    '--d1',
    'Content-Type: text/plain',
    '',
    'DMARC aggregate report attached.',
    '--d1',
    'Content-Type: application/gzip; name="report.xml.gz"',
    'Content-Transfer-Encoding: base64',
    '',
    wrapped,
    '--d1--',
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
    testEnv.DB.prepare(
      `INSERT INTO mailbox_receivers (id, mailbox_id, domain_id, priority,
         address_pattern, action, webhook_sub_id, forward_to, enabled, created_at, disabled_at)
       VALUES ('rcpt-dmarc', ?, 'plrs', 10, 'dmarc-rua@*', 'webhook', NULL, NULL, 1, ?, NULL)`,
    ).bind(PLATFORM_MAILBOX_ID, now),
  ]);
});

beforeEach(async () => {
  await testEnv.DB.prepare(`DELETE FROM dmarc_aggregate_reports`).run();
  await testEnv.DB.prepare(`DELETE FROM dmarc_alignment_rollup`).run();
});

describe('W6 — DMARC RUA ingest', () => {
  it('parses + persists report + writes rollup', async () => {
    const msg = mockMessage({
      to: 'dmarc-rua@plrs.im',
      from: 'noreply-dmarc@isp.example',
      raw: buildMime('shop.example', 100, 5),
    });
    await worker.email!(msg, testEnv as unknown as never, {} as ExecutionContext);

    const report = await testEnv.DB.prepare(
      `SELECT domain, total_count, total_dmarc_pass, total_dkim_pass, total_spf_pass, policy_p
       FROM dmarc_aggregate_reports LIMIT 1`,
    ).first<{
      domain: string;
      total_count: number;
      total_dmarc_pass: number;
      total_dkim_pass: number;
      total_spf_pass: number;
      policy_p: string;
    }>();
    expect(report?.domain).toBe('shop.example');
    expect(report?.total_count).toBe(105);
    expect(report?.total_dkim_pass).toBe(100);
    expect(report?.total_spf_pass).toBe(100);
    expect(report?.policy_p).toBe('none');

    const rollup = await testEnv.DB.prepare(
      `SELECT reports, total_count, dmarc_pass FROM dmarc_alignment_rollup WHERE domain = 'shop.example'`,
    ).first<{ reports: number; total_count: number; dmarc_pass: number }>();
    expect(rollup?.reports).toBe(1);
    expect(rollup?.total_count).toBe(105);
    expect(rollup?.dmarc_pass).toBe(100);
  });

  it('accumulates rollup across multiple reports same day', async () => {
    for (const [pass, fail] of [
      [50, 2],
      [80, 3],
    ] as Array<[number, number]>) {
      const msg = mockMessage({
        to: 'dmarc-rua@plrs.im',
        from: 'noreply-dmarc@isp.example',
        raw: buildMime('repeat.example', pass, fail),
      });
      await worker.email!(msg, testEnv as unknown as never, {} as ExecutionContext);
    }
    const rollup = await testEnv.DB.prepare(
      `SELECT reports, total_count, dkim_pass FROM dmarc_alignment_rollup WHERE domain = 'repeat.example'`,
    ).first<{ reports: number; total_count: number; dkim_pass: number }>();
    expect(rollup?.reports).toBe(2);
    expect(rollup?.total_count).toBe(50 + 2 + 80 + 3);
    expect(rollup?.dkim_pass).toBe(50 + 80);
  });
});
