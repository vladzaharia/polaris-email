import { describe, it, expect } from 'vitest';
import * as cfApi from '../src/index.js';

describe('cf-api package exports', () => {
  it('re-exports the MTA-STS provisioner surface', () => {
    expect(typeof cfApi.generatePolicyId).toBe('function');
    expect(typeof cfApi.expectedMtaStsRecords).toBe('function');
    expect(typeof cfApi.expectedTlsRptRecord).toBe('function');
    expect(typeof cfApi.provisionMtaSts).toBe('function');
    expect(typeof cfApi.unprovisionMtaSts).toBe('function');
    expect(typeof cfApi.provisionTlsRpt).toBe('function');
    expect(typeof cfApi.unprovisionTlsRpt).toBe('function');
    expect(typeof cfApi.verifyMtaSts).toBe('function');
    expect(typeof cfApi.verifyTlsRpt).toBe('function');
  });

  it('re-exports the workers-routes surface', () => {
    expect(typeof cfApi.attachCustomDomain).toBe('function');
    expect(typeof cfApi.findCustomDomain).toBe('function');
    expect(typeof cfApi.detachCustomDomain).toBe('function');
  });
});
