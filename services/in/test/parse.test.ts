import { describe, expect, it } from 'vitest';
import { parseMime, ParseError } from '../src/parse.js';

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe('parseMime', () => {
  it('parses a simple text email', async () => {
    const msg = [
      'From: Alice <alice@example.com>',
      'To: bob@example.com',
      'Subject: Hello',
      'Date: Mon, 1 Jan 2024 00:00:00 GMT',
      'Message-ID: <abc@example.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Hello world!',
    ].join('\r\n');
    const p = await parseMime(enc(msg));
    expect(p.from).toBe('alice@example.com');
    expect(p.to).toEqual(['bob@example.com']);
    expect(p.subject).toBe('Hello');
    expect(p.messageId).toBe('<abc@example.com>');
    expect(p.textBody).toBe('Hello world!');
  });

  it('parses encoded subject', async () => {
    const msg = [
      'From: a@b.com',
      'To: c@d.com',
      'Subject: =?utf-8?B?SGVsbG8gV29ybGQ=?=',
      'Content-Type: text/plain',
      '',
      'body',
    ].join('\r\n');
    const p = await parseMime(enc(msg));
    expect(p.subject).toBe('Hello World');
  });

  it('parses multipart with attachment', async () => {
    const boundary = 'BOUND';
    const msg = [
      'From: a@b.com',
      'To: c@d.com',
      'Subject: with attach',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain',
      '',
      'Hello!',
      `--${boundary}`,
      'Content-Type: application/pdf; name="x.pdf"',
      'Content-Disposition: attachment; filename="x.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      btoa('PDFBYTES'),
      `--${boundary}--`,
    ].join('\r\n');
    const p = await parseMime(enc(msg));
    expect(p.textBody).toBe('Hello!');
    expect(p.attachments).toHaveLength(1);
    expect(p.attachments[0]?.filename).toBe('x.pdf');
    expect(new TextDecoder().decode(p.attachments[0]?.bytes ?? new Uint8Array())).toBe('PDFBYTES');
  });

  it('extracts auth results', async () => {
    const msg = [
      'From: a@b.com',
      'To: c@d.com',
      'Subject: s',
      'Authentication-Results: mx.cloudflare; spf=pass; dkim=fail; dmarc=pass',
      'Content-Type: text/plain',
      '',
      'b',
    ].join('\r\n');
    const p = await parseMime(enc(msg));
    expect(p.authResults.spf).toBe('pass');
    expect(p.authResults.dkim).toBe('fail');
    expect(p.authResults.dmarc).toBe('pass');
  });

  it('rejects empty input', async () => {
    await expect(parseMime(new Uint8Array(0))).rejects.toBeInstanceOf(ParseError);
  });

  it('rejects too large', async () => {
    const big = new Uint8Array(26 * 1024 * 1024);
    await expect(parseMime(big)).rejects.toMatchObject({ code: 'too_large' });
  });

  it('parses quoted-printable body', async () => {
    const msg = [
      'From: a@b.com',
      'To: c@d.com',
      'Subject: qp',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Hello=20World',
    ].join('\r\n');
    const p = await parseMime(enc(msg));
    expect(p.textBody).toBe('Hello World');
  });
});
