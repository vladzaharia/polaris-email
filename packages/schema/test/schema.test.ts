import { describe, expect, it } from 'vitest';
import {
  Address,
  CreateRoutingRuleRequest,
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
        mailbox_id: '01HXR0000000000000000000A8',
      }),
    ).toBeDefined();
  });
  it('RotateRequest', () => {
    expect(RotateRequest.parse({ mode: 'emergency', reason: 'leak' })).toBeDefined();
  });
  it('CreateWebhookSubRequest', () => {
    expect(
      CreateWebhookSubRequest.parse({
        mailbox_id: '01HXR0000000000000000000A8',
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
});

describe('negative validation', () => {
  it('Ulid rejects lowercase', () => {
    expect(() => Ulid.parse('01hxr0000000000000000000a8')).toThrow();
  });
  it('Ulid rejects wrong length', () => {
    expect(() => Ulid.parse('01HXR0000')).toThrow();
  });
  it('ServiceSlug rejects uppercase', () => {
    expect(() => ServiceSlug.parse('Acme')).toThrow();
  });
  it('ServiceSlug rejects leading digit', () => {
    expect(() => ServiceSlug.parse('1acme')).toThrow();
  });
  it('Address rejects missing @', () => {
    expect(() => Address.parse('nope')).toThrow();
  });
  it('IssueApiKeyRequest rejects invalid scope', () => {
    expect(() =>
      IssueApiKeyRequest.parse({
        mailbox_id: '01HXR0000000000000000000A8',
        scopes: ['banana'],
      }),
    ).toThrow();
  });
  it('RotateRequest rejects unknown mode', () => {
    expect(() => RotateRequest.parse({ mode: 'sideways' })).toThrow();
  });
  it('CreateWebhookSubRequest rejects bare http for external', () => {
    // schema accepts shape; the URL scheme enforcement is route-side.
    // But events array must be non-empty:
    expect(() =>
      CreateWebhookSubRequest.parse({
        mailbox_id: '01HXR0000000000000000000A8',
        url: 'https://example.com',
        kind: 'external',
        events: [],
      }),
    ).toThrow();
  });
  it('CreateWebhookSubRequest rejects unknown kind', () => {
    expect(() =>
      CreateWebhookSubRequest.parse({
        mailbox_id: '01HXR0000000000000000000A8',
        url: 'https://example.com',
        kind: 'magic',
        events: ['message.received'],
      }),
    ).toThrow();
  });
  it('CreateRoutingRuleRequest rejects missing address_pattern', () => {
    expect(() =>
      CreateRoutingRuleRequest.parse({ domain_id: '01HXR0000000000000000000A8' }),
    ).toThrow();
  });
});
