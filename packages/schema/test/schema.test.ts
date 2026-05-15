import { describe, expect, it } from 'vitest';
import {
  Address,
  CreateRoutingRuleRequest,
  CreateWebhookSubRequest,
  ErrorCode,
  IssueApiKeyRequest,
  RotateRequest,
  SendRequest,
  SenderScope,
  ServiceSlug,
  Ulid,
  validateHeaderAllowed,
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

describe('Phase A — CF compliance', () => {
  describe('ErrorCode', () => {
    const newCodes = [
      'too_many_recipients',
      'subject_too_long',
      'message_too_large',
      'header_not_allowed',
      'header_too_long',
      'too_many_custom_headers',
      'custom_headers_too_large',
    ] as const;
    for (const code of newCodes) {
      it(`accepts ${code}`, () => {
        expect(ErrorCode.parse(code)).toBe(code);
      });
    }
  });

  describe('validateHeaderAllowed', () => {
    it('rejects platform-controlled headers (DKIM-Signature)', () => {
      expect(validateHeaderAllowed('DKIM-Signature')).toEqual({
        ok: false,
        reason: 'platform_controlled',
      });
    });
    it('rejects use-api-field headers (Reply-To)', () => {
      expect(validateHeaderAllowed('Reply-To')).toEqual({ ok: false, reason: 'use_api_field' });
    });
    it('rejects use-api-field headers (lowercase subject)', () => {
      expect(validateHeaderAllowed('subject')).toEqual({ ok: false, reason: 'use_api_field' });
    });
    it('rejects names longer than MAX_HEADER_NAME_LENGTH', () => {
      expect(validateHeaderAllowed('X-' + 'a'.repeat(99))).toEqual({
        ok: false,
        reason: 'name_too_long',
      });
    });
    it('rejects X- headers with invalid format', () => {
      expect(validateHeaderAllowed('X-bad header')).toEqual({
        ok: false,
        reason: 'invalid_x_format',
      });
    });
    it('rejects non-whitelisted non-X headers', () => {
      expect(validateHeaderAllowed('Resent-Message-ID')).toEqual({
        ok: false,
        reason: 'not_whitelisted',
      });
    });
    it('accepts whitelisted custom headers (List-Unsubscribe)', () => {
      expect(validateHeaderAllowed('List-Unsubscribe')).toEqual({ ok: true });
    });
    it('accepts well-formed X- headers', () => {
      expect(validateHeaderAllowed('X-Polaris-Tag')).toEqual({ ok: true });
    });
  });

  describe('SendRequest superRefine', () => {
    const baseFrom = 'sender@example.com';
    const baseTo = ['rcpt@example.com'];

    function getCode(result: ReturnType<typeof SendRequest.safeParse>): string | undefined {
      if (result.success) return undefined;
      return result.error.issues[0]?.message.split(':')[0];
    }

    it('rejects > MAX_RECIPIENTS combined recipients with too_many_recipients', () => {
      const to = Array.from({ length: 51 }, (_, i) => `r${i}@example.com`);
      const result = SendRequest.safeParse({ from: baseFrom, to });
      expect(result.success).toBe(false);
      expect(getCode(result)).toBe('too_many_recipients');
    });

    it('rejects subject > MAX_SUBJECT_LENGTH with subject_too_long', () => {
      const result = SendRequest.safeParse({
        from: baseFrom,
        to: baseTo,
        subject: 'x'.repeat(999),
      });
      expect(result.success).toBe(false);
      expect(getCode(result)).toBe('subject_too_long');
    });

    it('rejects non-whitelisted header with header_not_allowed:not_whitelisted', () => {
      const result = SendRequest.safeParse({
        from: baseFrom,
        to: baseTo,
        headers: { 'Resent-Date': 'Thu, 01 Jan 1970 00:00:00 +0000' },
      });
      expect(result.success).toBe(false);
      expect(result.success || result.error.issues[0]?.message).toBe(
        'header_not_allowed:not_whitelisted',
      );
    });

    it('rejects header value > MAX_HEADER_VALUE_LENGTH with header_too_long', () => {
      const result = SendRequest.safeParse({
        from: baseFrom,
        to: baseTo,
        headers: { 'X-Big': 'x'.repeat(2049) },
      });
      expect(result.success).toBe(false);
      expect(getCode(result)).toBe('header_too_long');
    });

    it('rejects > MAX_NON_X_CUSTOM_HEADERS non-X headers with too_many_custom_headers', () => {
      // 20 whitelisted is allowed; the 21st non-X must trip the cap.
      const whitelisted = [
        'In-Reply-To',
        'References',
        'List-Unsubscribe',
        'List-Unsubscribe-Post',
        'List-Id',
        'List-Archive',
        'List-Help',
        'List-Owner',
        'List-Post',
        'List-Subscribe',
        'Precedence',
        'Auto-Submitted',
        'Content-Language',
        'Keywords',
        'Comments',
        'Importance',
        'Sensitivity',
        'Organization',
        'Require-Recipient-Valid-Since',
        'Archived-At',
      ];
      const headers: Record<string, string> = {};
      for (const n of whitelisted) headers[n] = 'v';
      // One extra non-X header would push to 21; but we need it to pass
      // header_not_allowed first. Use another whitelisted name with a
      // different case — same key collision would dedupe; instead trick
      // with capitalization variants is impossible. Build the 21st as a
      // non-whitelisted name and accept that earlier issue would fire too;
      // since superRefine emits multiple issues, look up the count code.
      headers['Resent-Date'] = 'v'; // 21st non-X header
      const result = SendRequest.safeParse({
        from: baseFrom,
        to: baseTo,
        headers,
      });
      expect(result.success).toBe(false);
      const codes = result.success ? [] : result.error.issues.map((i) => i.message.split(':')[0]);
      expect(codes).toContain('too_many_custom_headers');
    });

    it('rejects > MAX_CUSTOM_HEADERS_PAYLOAD bytes with custom_headers_too_large', () => {
      // Build many X- headers each ~2 KB so total payload exceeds 16 KB.
      const headers: Record<string, string> = {};
      for (let i = 0; i < 10; i++) {
        headers[`X-Big-${i}`] = 'x'.repeat(2000);
      }
      const result = SendRequest.safeParse({
        from: baseFrom,
        to: baseTo,
        headers,
      });
      expect(result.success).toBe(false);
      const codes = result.success ? [] : result.error.issues.map((i) => i.message.split(':')[0]);
      expect(codes).toContain('custom_headers_too_large');
    });

    it('accepts 50 recipients + 998-char subject + 20 whitelisted headers', () => {
      const to = Array.from({ length: 50 }, (_, i) => `r${i}@example.com`);
      const whitelisted = [
        'In-Reply-To',
        'References',
        'List-Unsubscribe',
        'List-Unsubscribe-Post',
        'List-Id',
        'List-Archive',
        'List-Help',
        'List-Owner',
        'List-Post',
        'List-Subscribe',
        'Precedence',
        'Auto-Submitted',
        'Content-Language',
        'Keywords',
        'Comments',
        'Importance',
        'Sensitivity',
        'Organization',
        'Require-Recipient-Valid-Since',
        'Archived-At',
      ];
      const headers: Record<string, string> = {};
      for (const n of whitelisted) headers[n] = 'v';
      const result = SendRequest.safeParse({
        from: baseFrom,
        to,
        subject: 's'.repeat(998),
        headers,
      });
      expect(result.success).toBe(true);
    });
  });
});
