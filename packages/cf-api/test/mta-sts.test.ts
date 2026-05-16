import { describe, it, expect } from 'vitest';
import { expectedMtaStsRecords, expectedTlsRptRecord, generatePolicyId } from '../src/mta-sts.js';

describe('generatePolicyId', () => {
  it('returns a deterministic timestamp ID for a fixed date', () => {
    const id = generatePolicyId(new Date('2026-05-15T12:00:00Z'));
    expect(id).toBe('20260515T120000Z');
  });

  it('produces a 16-char alphanumeric ID conforming to RFC 8461 §3.1', () => {
    const id = generatePolicyId();
    // RFC 8461 allows 1*32(ALPHA / DIGIT); we use a 16-char compressed ISO ts.
    expect(id).toMatch(/^[0-9A-Z]+$/);
    expect(id.length).toBe(16);
  });
});

describe('expectedMtaStsRecords', () => {
  it('returns exactly one TXT record at _mta-sts.{domain} with v=STSv1; id=<policyId>', () => {
    const recs = expectedMtaStsRecords({ domain: 'acme.com', policyId: '20260515T120000Z' });
    expect(recs).toHaveLength(1);
    expect(recs[0].type).toBe('TXT');
    expect(recs[0].name).toBe('_mta-sts.acme.com');
    expect(recs[0].content).toBe('v=STSv1; id=20260515T120000Z');
  });

  it('does NOT include a CNAME for mta-sts.{domain} (that is a Worker custom domain)', () => {
    const recs = expectedMtaStsRecords({ domain: 'acme.com', policyId: 'X' });
    expect(recs.find((r) => r.type === 'CNAME')).toBeUndefined();
    expect(recs.find((r) => r.name === 'mta-sts.acme.com')).toBeUndefined();
  });
});

describe('expectedTlsRptRecord', () => {
  it('returns a TXT record at _smtp._tls.{domain} with v=TLSRPTv1; rua=<uri>', () => {
    const rec = expectedTlsRptRecord({
      domain: 'acme.com',
      rua: 'mailto:tlsrpt@acme.com',
    });
    expect(rec.type).toBe('TXT');
    expect(rec.name).toBe('_smtp._tls.acme.com');
    expect(rec.content).toBe('v=TLSRPTv1; rua=mailto:tlsrpt@acme.com');
  });

  it('passes the rua URI through verbatim (HTTPS or comma-separated)', () => {
    const rec = expectedTlsRptRecord({
      domain: 'acme.com',
      rua: 'https://tlsrpt.example.com/r,mailto:tlsrpt@acme.com',
    });
    expect(rec.content).toBe('v=TLSRPTv1; rua=https://tlsrpt.example.com/r,mailto:tlsrpt@acme.com');
  });
});
