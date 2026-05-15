// Phase A.4 — verifies that every ErrorCode in @polaris-email/schema has a
// corresponding HTTP status and retryable flag mapping in errors.ts. This
// catches the typical drift where the schema enum is extended but the
// `Record<ErrorCode, …>` maps in errors.ts are not, which TypeScript would
// also block at compile time — the runtime assertion below is a belt-and-
// braces guard against `as` casts or future widening.
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@polaris-email/schema';
import { ERROR_HTTP, ERROR_RETRYABLE } from '../src/errors.js';

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
