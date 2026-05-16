import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { parseDmarcReportXml, parseGzippedDmarcReport } from '../src/index.js';

const SAMPLE_XML = `<?xml version="1.0"?>
<feedback>
  <report_metadata>
    <org_name>google.com</org_name>
    <email>noreply-dmarc@google.com</email>
    <report_id>abc-2026-05-16</report_id>
    <date_range>
      <begin>1747353600</begin>
      <end>1747440000</end>
    </date_range>
  </report_metadata>
  <policy_published>
    <domain>example.com</domain>
    <adkim>r</adkim>
    <aspf>r</aspf>
    <p>quarantine</p>
    <sp>quarantine</sp>
    <pct>100</pct>
  </policy_published>
  <record>
    <row>
      <source_ip>203.0.113.5</source_ip>
      <count>42</count>
      <policy_evaluated>
        <disposition>none</disposition>
        <dkim>pass</dkim>
        <spf>pass</spf>
      </policy_evaluated>
    </row>
    <identifiers><header_from>example.com</header_from></identifiers>
    <auth_results>
      <dkim><domain>example.com</domain><result>pass</result></dkim>
      <spf><domain>example.com</domain><result>pass</result></spf>
    </auth_results>
  </record>
  <record>
    <row>
      <source_ip>198.51.100.7</source_ip>
      <count>3</count>
      <policy_evaluated>
        <disposition>quarantine</disposition>
        <dkim>fail</dkim>
        <spf>fail</spf>
      </policy_evaluated>
    </row>
    <identifiers><header_from>example.com</header_from></identifiers>
    <auth_results>
      <dkim><domain>example.com</domain><result>fail</result></dkim>
      <spf><domain>impersonator.example</domain><result>fail</result></spf>
    </auth_results>
  </record>
</feedback>`;

describe('parseDmarcReportXml', () => {
  it('extracts metadata, policy, records, and per-record auth detail', () => {
    const r = parseDmarcReportXml(SAMPLE_XML);
    expect(r.orgName).toBe('google.com');
    expect(r.orgEmail).toBe('noreply-dmarc@google.com');
    expect(r.reportId).toBe('abc-2026-05-16');
    expect(r.dateRangeBegin).toBe('2025-05-16T00:00:00.000Z');
    expect(r.policyDomain).toBe('example.com');
    expect(r.policyP).toBe('quarantine');
    expect(r.policyPct).toBe(100);
    expect(r.records).toHaveLength(2);
    expect(r.records[0]!.sourceIp).toBe('203.0.113.5');
    expect(r.records[0]!.count).toBe(42);
    expect(r.records[0]!.dkimEvaluated).toBe('pass');
    expect(r.records[1]!.spfAuthDomain).toBe('impersonator.example');
    expect(r.totalCount).toBe(45);
    expect(r.totalDkimPass).toBe(42);
    expect(r.totalSpfPass).toBe(42);
    expect(r.totalDmarcPass).toBe(42);
  });

  it('tolerates missing optional fields', () => {
    const r = parseDmarcReportXml('<feedback></feedback>');
    expect(r.orgName).toBeNull();
    expect(r.records).toEqual([]);
    expect(r.totalCount).toBe(0);
  });
});

describe('parseGzippedDmarcReport', () => {
  it('round-trips gzip(XML) → structured report', async () => {
    const gz = new Uint8Array(gzipSync(SAMPLE_XML));
    const r = await parseGzippedDmarcReport(gz);
    expect(r.orgName).toBe('google.com');
    expect(r.totalCount).toBe(45);
  });
});
