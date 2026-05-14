import { describe, it, expect } from 'vitest';
import { parseStrict } from '../src/canonicalize.js';
import {
  enforceSenderPolicy,
  extractSingleAddress,
  SenderPolicyError,
} from '../src/sender-policy.js';

const enc = new TextEncoder();
const policy = { allowedSenders: ['noreply@acme.com', 'alerts@billing.acme.com'] };

function mime(s: string) {
  return parseStrict(enc.encode(s));
}

describe('extractSingleAddress', () => {
  it('extracts a bare addr-spec', () => {
    expect(extractSingleAddress('noreply@acme.com')).toBe('noreply@acme.com');
  });

  it('extracts from name-addr form', () => {
    expect(extractSingleAddress('"No Reply" <noreply@acme.com>')).toBe('noreply@acme.com');
  });

  it('returns null on multiple addresses', () => {
    expect(extractSingleAddress('a@b.com, c@d.com')).toBeNull();
  });

  it('returns null on group syntax', () => {
    expect(extractSingleAddress('Devs: a@b.com, c@d.com;')).toBeNull();
  });
});

describe('enforceSenderPolicy', () => {
  it('accepts when From matches allow-list', () => {
    const m = mime('From: noreply@acme.com\r\nDate: x\r\n\r\n');
    expect(() => enforceSenderPolicy(m, policy)).not.toThrow();
  });

  it('rejects when From is not in allow-list', () => {
    const m = mime('From: ceo@acme.com\r\nDate: x\r\n\r\n');
    expect(() => enforceSenderPolicy(m, policy)).toThrow(SenderPolicyError);
  });

  it('rejects when From is missing', () => {
    const m = mime('Date: x\r\n\r\n');
    expect(() => enforceSenderPolicy(m, policy)).toThrow(/missing From/);
  });

  it('rejects multi-mailbox From (RFC 6854)', () => {
    const m = mime('From: a@b.com, c@d.com\r\nDate: x\r\n\r\n');
    expect(() => enforceSenderPolicy(m, policy)).toThrow(/exactly one mailbox/);
  });

  it('rejects when Sender is set to a non-allowed address', () => {
    const m = mime('From: noreply@acme.com\r\nSender: attacker@evil.com\r\nDate: x\r\n\r\n');
    expect(() => enforceSenderPolicy(m, policy)).toThrow(/Sender:.*not in allowed_senders/);
  });

  it('accepts when Sender matches allow-list', () => {
    const m = mime('From: noreply@acme.com\r\nSender: alerts@billing.acme.com\r\nDate: x\r\n\r\n');
    expect(() => enforceSenderPolicy(m, policy)).not.toThrow();
  });

  it('rejects when Reply-To is non-allowed', () => {
    const m = mime('From: noreply@acme.com\r\nReply-To: phisher@evil.com\r\nDate: x\r\n\r\n');
    expect(() => enforceSenderPolicy(m, policy)).toThrow(/Reply-To/);
  });

  it('case-insensitive address matching', () => {
    const m = mime('From: NoReply@AcMe.CoM\r\nDate: x\r\n\r\n');
    expect(() => enforceSenderPolicy(m, policy)).not.toThrow();
  });
});
