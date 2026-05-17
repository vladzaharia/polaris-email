import { describe, it, expect } from 'vitest';
import { scrub } from '../src/log-scrub.js';

describe('log-scrub', () => {
  it('redacts top-level email-shaped recipient fields', () => {
    const out = scrub({ to: 'user@example.com', cc: ['a@b.com'], from: 'sender@x.io' });
    expect(out).toEqual({ to: '<redacted>', cc: '<redacted>', from: '<redacted>' });
  });

  it('redacts body text/html/content_b64 fields verbatim', () => {
    const out = scrub({ text: 'secret body', html: '<p>x</p>', content_b64: 'AAAA' });
    expect(out).toEqual({ text: '<redacted>', html: '<redacted>', content_b64: '<redacted>' });
  });

  it('truncates subject to 32 chars', () => {
    const longSubject = 'a'.repeat(100);
    const out = scrub({ subject: longSubject }) as { subject: string };
    expect(out.subject.length).toBeLessThanOrEqual(32);
  });

  it('rewrites email addresses inside free-text strings', () => {
    const out = scrub('hello user@example.com world');
    expect(out).toBe('hello <email> world');
  });

  it('rewrites long base64 blobs to <blob>', () => {
    const longBlob = 'A'.repeat(120);
    const out = scrub(`prefix ${longBlob} suffix`);
    expect(out).toBe('prefix <blob> suffix');
  });

  it('does not leak bearer-token-like prefixes through arbitrary keys', () => {
    // The intent of this test is to lock in the behavior that scrub() does
    // NOT silently allow sk_* / wh_* / sec_* values to pass through. If a
    // future change adds new prefix detection it can land here.
    const sensitive = {
      secret: 'sk_live_abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
    };
    const out = scrub(sensitive);
    expect(JSON.stringify(out)).not.toMatch(/sk_live_[a-z0-9]{30,}/);
  });

  it('recurses through nested objects + arrays', () => {
    const out = scrub({
      meta: { from: 'a@b.com', nested: { to: 'c@d.com' } },
      items: [{ from: 'e@f.com' }],
    });
    expect(out).toEqual({
      meta: { from: '<redacted>', nested: { to: '<redacted>' } },
      items: [{ from: '<redacted>' }],
    });
  });
});
