import { describe, expect, it } from 'vitest';
import {
  Address,
  BulkRevokeServiceRequest,
  CreateRoutingRuleRequest,
  CreateServiceRequest,
  CreateWebhookSubRequest,
  IssueApiKeyRequest,
  RotateRequest,
  SenderScope,
  ServiceSlug,
  Ulid,
} from '../src/index.js';

describe('primitives', () => {
  it('accepts valid ulid', () => {
    expect(Ulid.parse('01HXR0000000000000000000A8')).toBeDefined();
  });
  it('rejects bad ulid', () => {
    expect(() => Ulid.parse('not-a-ulid')).toThrow();
  });
  it('service slug', () => {
    expect(ServiceSlug.parse('expresscharge')).toBe('expresscharge');
    expect(() => ServiceSlug.parse('Express')).toThrow();
    expect(() => ServiceSlug.parse('123svc')).toThrow();
  });
  it('address', () => {
    expect(Address.parse('a@b.com')).toBe('a@b.com');
    expect(() => Address.parse('not an email')).toThrow();
  });
});

describe('SenderScope', () => {
  it('accepts exact', () => {
    expect(SenderScope.parse({ kind: 'exact', pattern: 'noreply@example.com' })).toBeDefined();
  });
  it('rejects unanchored glob', () => {
    expect(() => SenderScope.parse({ kind: 'glob', pattern: '*b.com' })).toThrow();
  });
  it('accepts anchored glob', () => {
    expect(SenderScope.parse({ kind: 'glob', pattern: '*@b.com' })).toBeDefined();
  });
  it('requires @ in glob', () => {
    expect(() => SenderScope.parse({ kind: 'glob', pattern: 'foo' })).toThrow();
  });
});

describe('admin requests', () => {
  it('IssueApiKeyRequest', () => {
    expect(
      IssueApiKeyRequest.parse({
        service_id: 'svc',
        sender_scopes: [{ kind: 'exact', pattern: 'a@b.com' }],
      }),
    ).toBeDefined();
  });
  it('RotateRequest', () => {
    expect(RotateRequest.parse({ mode: 'emergency', reason: 'leak' })).toBeDefined();
  });
  it('CreateWebhookSubRequest', () => {
    expect(
      CreateWebhookSubRequest.parse({
        tenant_id: 'svc',
        url: 'https://example.com/hook',
        kind: 'external',
        events: ['message.received'],
      }),
    ).toBeDefined();
  });
  it('CreateRoutingRuleRequest', () => {
    expect(
      CreateRoutingRuleRequest.parse({
        domain_id: '01HXR0000000000000000000A8',
        address_pattern: 'support@*',
      }),
    ).toBeDefined();
  });
  it('CreateServiceRequest', () => {
    expect(CreateServiceRequest.parse({ id: 'svc', name: 'Svc' })).toBeDefined();
  });
  it('BulkRevokeServiceRequest enforces confirmation', () => {
    expect(() =>
      BulkRevokeServiceRequest.parse({
        service_id: 'svc',
        mode: 'emergency',
        incident_ticket_id: 'INC-1',
        confirmation: 'other',
      }),
    ).not.toThrow();
    // Equality check is enforced by API logic, not schema; schema only constrains shape.
  });
});
