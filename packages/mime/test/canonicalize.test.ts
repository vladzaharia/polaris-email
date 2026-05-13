import { describe, it, expect } from 'vitest';
import { parseStrict, serialize, getHeader, setHeader, MimeError } from '../src/canonicalize.js';

const enc = new TextEncoder();

function mime(s: string): Uint8Array {
  return enc.encode(s);
}

describe('parseStrict', () => {
  it('parses a minimal message with CRLF line endings', () => {
    const m = parseStrict(
      mime(
        'From: alice@example.com\r\n' +
          'To: bob@example.com\r\n' +
          'Subject: hello\r\n' +
          'Date: Mon, 12 May 2026 12:00:00 +0000\r\n' +
          '\r\n' +
          'body text\r\n'
      )
    );
    expect(getHeader(m, 'from')).toBe('alice@example.com');
    expect(getHeader(m, 'subject')).toBe('hello');
    expect(new TextDecoder().decode(m.body)).toBe('body text\r\n');
  });

  it('handles header continuation (folded headers)', () => {
    const m = parseStrict(
      mime(
        'Subject: this subject\r\n is folded across two lines\r\n' +
          'From: a@b.com\r\n' +
          '\r\n'
      )
    );
    expect(getHeader(m, 'subject')).toBe('this subject is folded across two lines');
  });

  it('rejects bare LF in headers', () => {
    expect(() =>
      parseStrict(mime('From: alice@example.com\nTo: bob@example.com\r\n\r\n'))
    ).toThrow(MimeError);
  });

  it('rejects NUL bytes', () => {
    const bytes = new Uint8Array([
      ...enc.encode('From: a@b.com\r\n'),
      0,
      ...enc.encode('To: c@d.com\r\n\r\n'),
    ]);
    expect(() => parseStrict(bytes)).toThrow(/NUL byte/);
  });

  it('rejects bare CR', () => {
    const bytes = new Uint8Array([...enc.encode('From: a@b.com\r'), 0x42, ...enc.encode('\r\n\r\n')]);
    expect(() => parseStrict(bytes)).toThrow(/bare CR/);
  });

  it('rejects oversized header lines', () => {
    const huge = 'X-Long: ' + 'a'.repeat(1000);
    expect(() => parseStrict(mime(huge + '\r\n\r\n'))).toThrow(/header line exceeds/);
  });

  it('rejects duplicate singleton headers (From)', () => {
    expect(() =>
      parseStrict(mime('From: a@b.com\r\nFrom: c@d.com\r\n\r\n'))
    ).toThrow(/duplicate singleton header/);
  });

  it('rejects forbidden submitter headers (Received)', () => {
    expect(() =>
      parseStrict(mime('Received: from anywhere\r\nFrom: a@b.com\r\n\r\n'))
    ).toThrow(/forbidden submitter header/);
  });

  it('rejects forbidden submitter headers (DKIM-Signature)', () => {
    expect(() =>
      parseStrict(mime('DKIM-Signature: v=1; a=rsa-sha256\r\nFrom: a@b.com\r\n\r\n'))
    ).toThrow(/forbidden submitter header/);
  });

  it('rejects when no header/body boundary exists', () => {
    expect(() => parseStrict(mime('From: a@b.com\r\n'))).toThrow(/no header.body boundary/);
  });

  it('rejects malformed header lines', () => {
    expect(() => parseStrict(mime('NotAHeader\r\nFrom: a@b.com\r\n\r\n'))).toThrow(
      /malformed header line/
    );
  });

  it('rejects continuation before any header', () => {
    expect(() => parseStrict(mime(' continuation\r\nFrom: a@b.com\r\n\r\n'))).toThrow(
      /continuation before any header|malformed header/
    );
  });
});

describe('serialize', () => {
  it('round-trips a parsed message preserving body bytes', () => {
    const original = mime(
      'From: alice@example.com\r\n' +
        'To: bob@example.com\r\n' +
        'Subject: hello\r\n' +
        '\r\n' +
        'body line 1\r\nbody line 2\r\n'
    );
    const parsed = parseStrict(original);
    const round = serialize(parsed);
    // Headers may be re-cased identically; body must be byte-for-byte.
    expect(new TextDecoder().decode(round)).toBe(new TextDecoder().decode(original));
  });
});

describe('setHeader', () => {
  it('inserts a new header at the front', () => {
    const m = parseStrict(mime('From: a@b.com\r\n\r\n'));
    setHeader(m, 'Return-Path', '<bounces@b.com>');
    expect(getHeader(m, 'return-path')).toBe('<bounces@b.com>');
    expect(m.headers[0]?.nameLc).toBe('return-path');
  });

  it('replaces an existing header in place', () => {
    const m = parseStrict(mime('From: a@b.com\r\nSubject: old\r\n\r\n'));
    setHeader(m, 'Subject', 'new');
    expect(getHeader(m, 'subject')).toBe('new');
    // Should not have created a duplicate.
    expect(m.headers.filter((h) => h.nameLc === 'subject').length).toBe(1);
  });
});
