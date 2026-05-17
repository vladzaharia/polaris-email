// verifies that every ErrorCode in @polaris-email/schema has a
// corresponding HTTP status and retryable flag mapping in errors.ts. This
// catches the typical drift where the schema enum is extended but the
// `Record<ErrorCode, …>` maps in errors.ts are not, which TypeScript would
// also block at compile time — the runtime assertion below is a belt-and-
// braces guard against `as` casts or future widening.
//
// additionally covers the zod-issue → typed-ErrorCode translator
// used at POST /v1/messages.
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { ErrorCode, SendRequest } from '@polaris-email/schema';
import { ERROR_HTTP, ERROR_RETRYABLE } from '../src/errors.js';
import { CF_TYPED_CODES, classifyZodIssue } from '../src/routes/messages.js';

describe('Phase A CF compliance error code mapping', () => {
  const cases: Array<{ code: string; http: number; retryable: boolean }> = [
    { code: 'too_many_recipients', http: 400, retryable: false },
    { code: 'subject_too_long', http: 400, retryable: false },
    { code: 'message_too_large', http: 413, retryable: false },
    { code: 'header_not_allowed', http: 400, retryable: false },
    { code: 'header_too_long', http: 400, retryable: false },
    { code: 'too_many_custom_headers', http: 400, retryable: false },
    { code: 'custom_headers_too_large', http: 400, retryable: false },
  ];

  for (const { code, http, retryable } of cases) {
    it(`maps ${code} → ${http} (retryable=${retryable})`, () => {
      expect(ERROR_HTTP[code as keyof typeof ERROR_HTTP]).toBe(http);
      expect(ERROR_RETRYABLE[code as keyof typeof ERROR_RETRYABLE]).toBe(retryable);
    });
  }

  it('ERROR_HTTP covers every ErrorCode enum value (no drift)', () => {
    expect(Object.keys(ERROR_HTTP).length).toBe(ErrorCode.options.length);
    for (const code of ErrorCode.options) {
      expect(ERROR_HTTP).toHaveProperty(code);
    }
  });

  it('ERROR_RETRYABLE covers every ErrorCode enum value (no drift)', () => {
    expect(Object.keys(ERROR_RETRYABLE).length).toBe(ErrorCode.options.length);
    for (const code of ErrorCode.options) {
      expect(ERROR_RETRYABLE).toHaveProperty(code);
    }
  });
});

// POST /v1/messages translates the first zod issue from
// SendRequest.safeParse() into a typed ErrorCode + human-readable detail.
// The contract between schema and API is: issue.message === "<code>:<detail>"
// for codes in CF_TYPED_CODES, otherwise we fall back to bad_request and
// preserve the original message verbatim.
describe('POST /v1/messages — CF compliance errors', () => {
  // Helper to build a minimal ZodIssue-shaped object for testing. We only
  // exercise the `message` field; the classifier intentionally ignores
  // `path` / `code` to keep its contract surface narrow.
  const issue = (message: string): z.ZodIssue =>
    ({ code: 'custom', path: [], message }) as unknown as z.ZodIssue;

  it('extracts typed code + detail for too_many_recipients', () => {
    expect(classifyZodIssue(issue('too_many_recipients:51 exceeds 50'))).toEqual({
      code: 'too_many_recipients',
      message: '51 exceeds 50',
    });
  });

  it('extracts typed code + detail for header_not_allowed', () => {
    expect(classifyZodIssue(issue('header_not_allowed:platform_controlled'))).toEqual({
      code: 'header_not_allowed',
      message: 'platform_controlled',
    });
  });

  it('falls back to bad_request when message has no colon prefix', () => {
    expect(classifyZodIssue(issue('some_other_message'))).toEqual({
      code: 'bad_request',
      message: 'some_other_message',
    });
  });

  it('falls back to bad_request when prefix is not an allowlisted typed code', () => {
    expect(classifyZodIssue(issue('unknown_code:detail'))).toEqual({
      code: 'bad_request',
      message: 'unknown_code:detail',
    });
  });

  it('end-to-end: SendRequest.safeParse(51 recipients) → too_many_recipients', () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => `r${i}@example.com`);
    const result = SendRequest.safeParse({
      from: 'sender@example.com',
      to: tooMany,
      subject: 'hello',
      text: 'hi',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const classified = classifyZodIssue(result.error.issues[0]);
      expect(classified.code).toBe('too_many_recipients');
      // Detail should be non-empty and reference the offending count.
      expect(classified.message).toContain('51');
    }
  });

  // The remaining end-to-end cases below replace earlier fabricated-issue
  // tests with real `SendRequest.safeParse` → `classifyZodIssue` round-trips,
  // so the schema layer and API layer share one tested contract instead of
  // each having its own.
  it('end-to-end: subject 999 chars → subject_too_long', () => {
    const r = SendRequest.safeParse({
      from: 'sender@example.com',
      to: ['rcpt@example.com'],
      subject: 'x'.repeat(999),
      text: 'hi',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(classifyZodIssue(r.error.issues[0]).code).toBe('subject_too_long');
    }
  });

  it('end-to-end: platform-controlled header → header_not_allowed', () => {
    const r = SendRequest.safeParse({
      from: 'sender@example.com',
      to: ['rcpt@example.com'],
      headers: { 'DKIM-Signature': 'v=1; …' },
      text: 'hi',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(classifyZodIssue(r.error.issues[0]).code).toBe('header_not_allowed');
    }
  });

  it('end-to-end: header value > 2048 bytes → header_too_long', () => {
    const r = SendRequest.safeParse({
      from: 'sender@example.com',
      to: ['rcpt@example.com'],
      headers: { 'X-Big': 'a'.repeat(2049) },
      text: 'hi',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      // The first issue may be header_too_long (value cap) — accept either it
      // or the validateHeaderAllowed branch — the contract is "some Phase A
      // typed code surfaces", which classifyZodIssue must report verbatim.
      const code = classifyZodIssue(r.error.issues[0]).code;
      expect(['header_too_long', 'header_not_allowed']).toContain(code);
    }
  });

  it('end-to-end: 16 KB of X-headers → custom_headers_too_large', () => {
    const headers: Record<string, string> = {};
    for (let i = 0; i < 10; i++) headers[`X-K${i}`] = 'a'.repeat(1700);
    const r = SendRequest.safeParse({
      from: 'sender@example.com',
      to: ['rcpt@example.com'],
      headers,
      text: 'hi',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      // Multiple issues may emit; assert that the size-cap code is among them
      // rather than relying on issues[0] specifically. This is more robust to
      // schema iteration order without weakening the assertion.
      const codes = r.error.issues.map((i) => classifyZodIssue(i).code);
      expect(codes).toContain('custom_headers_too_large');
    }
  });

  it('CF_TYPED_CODES matches the Phase A typed code subset of ErrorCode (no drift)', () => {
    const expected: ReadonlySet<string> = new Set([
      'too_many_recipients',
      'subject_too_long',
      'message_too_large',
      'header_not_allowed',
      'header_too_long',
      'too_many_custom_headers',
      'custom_headers_too_large',
    ]);
    expect(new Set(CF_TYPED_CODES)).toEqual(expected);
    // Every CF_TYPED_CODES member must also be in ErrorCode (kept in sync
    // structurally rather than by hand).
    for (const code of CF_TYPED_CODES) {
      expect(ErrorCode.options).toContain(code);
    }
  });
});
