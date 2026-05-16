import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { gunzipJsonReport, parseGzippedTlsRptReport, parseTlsRptReportJson } from '../src/index.js';

const SAMPLE = {
  'organization-name': 'Example ISP',
  'contact-info': 'tls-rpt@isp.example',
  'report-id': '2026-05-16T00:00:00Z_example.com',
  'date-range': {
    'start-datetime': '2026-05-15T00:00:00Z',
    'end-datetime': '2026-05-15T23:59:59Z',
  },
  policies: [
    {
      policy: {
        'policy-type': 'sts',
        'policy-domain': 'example.com',
        'policy-string': [
          'version: STSv1',
          'mode: enforce',
          'mx: *.mx.cloudflare.net',
          'max_age: 86400',
        ],
        'mx-host': ['*.mx.cloudflare.net'],
      },
      summary: {
        'total-successful-session-count': 117,
        'total-failure-session-count': 2,
      },
      'failure-details': [
        {
          'result-type': 'certificate-expired',
          'sending-mta-ip': '203.0.113.45',
          'receiving-mx-hostname': 'route1.mx.cloudflare.net',
          'receiving-ip': '162.159.140.99',
          'failed-session-count': 2,
          'additional-information': 'cert NotAfter=2026-05-10',
        },
      ],
    },
    {
      policy: {
        'policy-type': 'no-policy-found',
        'policy-domain': 'other.example',
      },
      summary: {
        'total-successful-session-count': 0,
        'total-failure-session-count': 0,
      },
    },
  ],
};

describe('parseTlsRptReportJson', () => {
  it('extracts org, contact, date range, totals, per-policy and per-failure details', () => {
    const r = parseTlsRptReportJson(SAMPLE);
    expect(r.organizationName).toBe('Example ISP');
    expect(r.contactInfo).toBe('tls-rpt@isp.example');
    expect(r.dateRangeStart).toBe('2026-05-15T00:00:00Z');
    expect(r.totalSuccessCount).toBe(117);
    expect(r.totalFailureCount).toBe(2);
    expect(r.policies).toHaveLength(2);
    const sts = r.policies[0]!;
    expect(sts.policyType).toBe('sts');
    expect(sts.policyDomain).toBe('example.com');
    expect(sts.policyString).toContain('mode: enforce');
    expect(sts.mxHost).toBe('*.mx.cloudflare.net');
    expect(sts.failures).toHaveLength(1);
    expect(sts.failures[0]!.resultType).toBe('certificate-expired');
    expect(sts.failures[0]!.failedSessionCount).toBe(2);
  });

  it('tolerates empty / missing fields without throwing', () => {
    const r = parseTlsRptReportJson({});
    expect(r.organizationName).toBeNull();
    expect(r.policies).toEqual([]);
    expect(r.totalSuccessCount).toBe(0);
    expect(r.totalFailureCount).toBe(0);
  });
});

describe('parseGzippedTlsRptReport', () => {
  it('round-trips gzip(JSON) → structured report', async () => {
    const gz = new Uint8Array(gzipSync(JSON.stringify(SAMPLE)));
    const r = await parseGzippedTlsRptReport(gz);
    expect(r.organizationName).toBe('Example ISP');
    expect(r.totalSuccessCount).toBe(117);
  });

  it('gunzipJsonReport returns the raw JSON object', async () => {
    const gz = new Uint8Array(gzipSync(JSON.stringify({ hello: 'world' })));
    const j = (await gunzipJsonReport(gz)) as Record<string, unknown>;
    expect(j.hello).toBe('world');
  });
});
