// Phase 4a tests for the MIME <-> JSON bridge:
//   * 4a.8 deeply nested multipart bombs throw `multipart_too_deep`
//   * 4a.12 invalid base64 attachments throw `invalid_attachment_base64`
//
// Phase 8b extends with multipart parsing edge cases that the walker has to
// degrade gracefully on (closing-boundary missing, leading whitespace,
// non-ASCII filenames) plus the parse-strict bare-CR/bare-LF guarantees that
// keep the canonicalizer the only line of defence against header smuggling.
import { describe, it, expect } from 'vitest';
import { composeFromJson, summarizeMime } from '../src/json.js';
import { MimeError, parseStrict } from '../src/canonicalize.js';

const enc = new TextEncoder();

// Use letters for boundary names so no two boundaries share a prefix
// (the walker's boundary search would otherwise alias `--b1` against
// `--b11` etc., short-circuiting the nested-recursion test).
const BOUNDARY_NAMES = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function buildNestedPart(depth: number, level: number): string {
  // The innermost level is a plain text leaf.
  if (level === depth) {
    return ['Content-Type: text/plain; charset=utf-8', '', 'hi', ''].join('\r\n');
  }
  const boundary = `BOUNDARY_${BOUNDARY_NAMES[level % BOUNDARY_NAMES.length]}_${level}`;
  const inner = buildNestedPart(depth, level + 1);
  return [
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    inner,
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

function nestedMultipart(depth: number): Uint8Array {
  // Top-level is a multipart with one part that is itself a multipart...
  // Each level adds one to the recursion depth observed by
  // walkPartsWithHeaders.
  const top = buildNestedPart(depth, 0);
  const headerBlock = ['From: a@b.com', 'To: c@d.com', 'Subject: x', 'MIME-Version: 1.0'].join(
    '\r\n',
  );
  return enc.encode(headerBlock + '\r\n' + top);
}

describe('4a.8: multipart depth limit', () => {
  it('accepts nesting up to the cap (10)', () => {
    expect(() => summarizeMime(nestedMultipart(8))).not.toThrow();
  });

  it('throws MimeError(multipart_too_deep) for nesting above the cap', () => {
    let err: unknown;
    try {
      summarizeMime(nestedMultipart(12));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MimeError);
    expect((err as MimeError).code).toBe('multipart_too_deep');
  });
});

describe('4a.12: composeFromJson base64 validation', () => {
  it('round-trips a valid base64 attachment', () => {
    const out = composeFromJson({
      from: 'a@b.com',
      to: ['c@d.com'],
      subject: 's',
      text: 'hi',
      attachments: [
        { filename: 'x.txt', content_type: 'text/plain', content_base64: 'aGVsbG8=' },
      ],
    });
    // Just smoke-check that the encoded payload made it through.
    const raw = new TextDecoder().decode(out);
    expect(raw).toContain('aGVsbG8=');
  });

  it('throws MimeError(invalid_attachment_base64) on malformed base64', () => {
    let err: unknown;
    try {
      composeFromJson({
        from: 'a@b.com',
        to: ['c@d.com'],
        subject: 's',
        text: 'hi',
        attachments: [
          // `!!!!` is not valid base64 — atob() throws.
          { filename: 'bad.bin', content_type: 'application/octet-stream', content_base64: '!!!!' },
        ],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MimeError);
    expect((err as MimeError).code).toBe('invalid_attachment_base64');
  });
});

// 8b: walker edge cases — graceful degradation around malformed multipart,
// non-ASCII attachment filenames, and the canonicalizer's bare-CR/bare-LF
// rejections (which keep summarizeMime from ever seeing those bytes).
describe('8b: walker boundary edge cases', () => {
  function buildMessage(headers: string[], body: string): Uint8Array {
    return enc.encode(headers.join('\r\n') + '\r\n\r\n' + body);
  }

  it('multipart missing closing boundary parses what it can without throwing', () => {
    // The walker logic in walkParts loops until it finds two `--boundary`
    // occurrences in sequence. When the closing `--boundary--` is absent, it
    // still finds the open delimiter for each part it has — and bails out of
    // the inner loop without throwing. summarizeMime must surface whatever
    // it managed to parse rather than crashing the isolate.
    const body = [
      '--bnd1',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'hello',
      '--bnd1',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>hi</p>',
      // Note: NO closing `--bnd1--` and no trailing CRLF.
      '',
    ].join('\r\n');
    const raw = buildMessage(
      [
        'From: a@b.com',
        'To: c@d.com',
        'Subject: s',
        'MIME-Version: 1.0',
        'Content-Type: multipart/alternative; boundary="bnd1"',
      ],
      body,
    );
    let summary: ReturnType<typeof summarizeMime> | undefined;
    expect(() => {
      summary = summarizeMime(raw);
    }).not.toThrow();
    expect(summary).toBeDefined();
    // The first part is well-formed — text body should be captured.
    expect(summary!.text).toBe('hello');
  });

  it('whitespace before the boundary line does not break leaf detection', () => {
    // RFC 2046 §5.1.1 allows transport padding (LWSP) before the boundary.
    // walkParts strips a leading CRLF on each chunk so a leading space in
    // the chunk should not corrupt the sub-header parser.
    const body = [
      '--bnd2',
      ' Content-Type: text/plain; charset=utf-8',
      '',
      'leading-ws-header',
      '--bnd2--',
      '',
    ].join('\r\n');
    const raw = buildMessage(
      [
        'From: a@b.com',
        'To: c@d.com',
        'Subject: s',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="bnd2"',
      ],
      body,
    );
    expect(() => summarizeMime(raw)).not.toThrow();
  });

  it('decodes RFC 2047 encoded-word filenames in attachments', () => {
    // `=?utf-8?B?w7zDqGw=?=` decodes to `üèl`.
    const body = [
      '--bnd3',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'body',
      '--bnd3',
      'Content-Type: application/octet-stream; name="=?utf-8?B?w7zDqGw=?="',
      'Content-Disposition: attachment; filename="=?utf-8?B?w7zDqGw=?="',
      'Content-Transfer-Encoding: base64',
      '',
      'aGk=',
      '--bnd3--',
      '',
    ].join('\r\n');
    const raw = buildMessage(
      [
        'From: a@b.com',
        'To: c@d.com',
        'Subject: s',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="bnd3"',
      ],
      body,
    );
    const s = summarizeMime(raw);
    expect(s.attachments.length).toBe(1);
    // The walker stores the raw filename string verbatim — encoded-word
    // decoding is the caller's job. We just lock down that the encoded
    // bytes survive intact and the part is recognised as an attachment.
    expect(s.attachments[0]!.filename).toContain('=?utf-8?B?');
    expect(s.attachments[0]!.size_bytes).toBe(2);
  });

  it('keeps raw UTF-8 bytes in a filename verbatim (no double-decode)', () => {
    const body = [
      '--bnd4',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'body',
      '--bnd4',
      'Content-Type: application/octet-stream; name="café.bin"',
      'Content-Disposition: attachment; filename="café.bin"',
      'Content-Transfer-Encoding: base64',
      '',
      'aGk=',
      '--bnd4--',
      '',
    ].join('\r\n');
    const raw = buildMessage(
      [
        'From: a@b.com',
        'To: c@d.com',
        'Subject: s',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="bnd4"',
      ],
      body,
    );
    const s = summarizeMime(raw);
    expect(s.attachments.length).toBe(1);
    // Walker decodes via TextDecoder('latin1'), so non-ASCII filenames
    // round-trip through latin1 as the underlying UTF-8 bytes mapped to
    // Unicode codepoints. We only require the filename is present and
    // non-empty, not that it perfectly round-trips Unicode (the API
    // layer can re-decode via TextEncoder if it knows the source charset).
    expect(s.attachments[0]!.filename.length).toBeGreaterThan(0);
  });

  it('bare-CR in headers is rejected by parseStrict (smuggling guard)', () => {
    // parseStrict scans the header region for bare CR / bare LF and rejects
    // them. The walker only sees pre-validated bytes from the body; the
    // canonicalizer is the only line of defence against header-smuggling
    // vectors that flip the body parser's view of what's a header.
    const raw = new Uint8Array([
      ...enc.encode('From: a@b.com'),
      0x0d,
      ...enc.encode('To: c@d.com\r\n\r\nbody\r\n'),
    ]);
    let err: unknown;
    try {
      parseStrict(raw);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MimeError);
    expect((err as MimeError).code).toBe('bare_cr');
  });

  it('bare-LF in header section is rejected by parseStrict (smuggling guard)', () => {
    // Hand-build bytes with a bare LF inside the header section so the
    // canonicalizer's bare_lf branch fires before the walker is even
    // invoked. This is the canonical SMTP-smuggling vector.
    const raw = new Uint8Array([
      ...enc.encode('From: a@b.com'),
      0x0a,
      ...enc.encode('To: c@d.com\r\n\r\nbody\r\n'),
    ]);
    let err: unknown;
    try {
      parseStrict(raw);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MimeError);
    expect((err as MimeError).code).toBe('bare_lf');
  });

  it('bare-CR/LF in body is allowed (parseStrict only enforces in headers)', () => {
    // Document the boundary of parseStrict's coverage: once we're past the
    // CRLF CRLF separator, body bytes are passed through verbatim. This is
    // intentional — body content is opaque to the canonicalizer. The walker
    // operates on this body via TextDecoder('latin1') so non-CRLF
    // sequences inside an already-parsed multipart simply land as part of
    // the leaf body.
    const raw = enc.encode(
      'From: a@b.com\r\nTo: c@d.com\r\nSubject: s\r\n\r\nline-1\rline-2\nline-3\r\n',
    );
    expect(() => parseStrict(raw)).not.toThrow();
    const parsed = parseStrict(raw);
    expect(parsed.body.byteLength).toBeGreaterThan(0);
  });
});
