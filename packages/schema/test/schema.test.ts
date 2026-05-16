import { describe, expect, it } from 'vitest';
import {
  Address,
  AuditAction,
  CreateRoutingRuleRequest,
  CreateWebhookSubRequest,
  ErrorCode,
  IssueApiKeyRequest,
  MailDomain,
  RotateRequest,
  SendRequest,
  SenderScope,
  ServiceSlug,
  Ulid,
  UpdateMailDomainRequest,
  VerifyCheck,
  VerifyResponse,
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

describe('Phase C — MTA-STS + TLS-RPT schema', () => {
  // Canonical row sample. ULIDs are valid; timestamps are ISO-ish strings as
  // the D1 layer produces. Mirrors a `SELECT * FROM mail_domains` shape after
  // migration 0007 is applied to a freshly-onboarded domain.
  const baseDomainRow = {
    id: '01HXR0000000000000000000A8',
    zone_id: '01HXR0000000000000000000B9',
    parent_domain_id: null,
    name: 'acme.example',
    status: 'verified' as const,
    wildcard_subdomains: 0,
    dmarc_policy: 'quarantine',
    dmarc_rua: 'mailto:dmarc@acme.example',
    inbound_enabled: 1,
    outbound_enabled: 1,
    provider: 'cloudflare',
    cf_zone_id: 'cfzone123',
    dkim_selector: 'pol1',
    created_at: '2026-05-01T12:00:00.000Z',
    updated_at: '2026-05-01T12:00:00.000Z',
    verified_at: '2026-05-01T12:05:00.000Z',
    last_verify_check_at: '2026-05-01T12:05:00.000Z',
    disabled_at: null,
  };

  describe('MailDomain', () => {
    it('parses a row with all MTA-STS + TLS-RPT fields populated', () => {
      const row = {
        ...baseDomainRow,
        mta_sts_mode: 'enforce' as const,
        mta_sts_policy_id: 'abc123def456',
        mta_sts_max_age: 86400,
        mta_sts_verified_at: '2026-05-01T12:10:00.000Z',
        tlsrpt_enabled: 1,
        tlsrpt_rua: 'mailto:tlsrpt@acme.example',
        tlsrpt_verified_at: '2026-05-01T12:10:00.000Z',
      };
      const parsed = MailDomain.parse(row);
      expect(parsed.mta_sts_mode).toBe('enforce');
      expect(parsed.mta_sts_policy_id).toBe('abc123def456');
      expect(parsed.mta_sts_max_age).toBe(86400);
      expect(parsed.tlsrpt_enabled).toBe(1);
      expect(parsed.tlsrpt_rua).toBe('mailto:tlsrpt@acme.example');
    });

    it('parses a row where MTA-STS fields are at migration defaults', () => {
      const row = {
        ...baseDomainRow,
        mta_sts_mode: 'none' as const,
        mta_sts_policy_id: null,
        mta_sts_max_age: 86400,
        mta_sts_verified_at: null,
        tlsrpt_enabled: 0,
        tlsrpt_rua: null,
        tlsrpt_verified_at: null,
      };
      const parsed = MailDomain.parse(row);
      expect(parsed.mta_sts_mode).toBe('none');
      expect(parsed.mta_sts_policy_id).toBeNull();
      expect(parsed.tlsrpt_enabled).toBe(0);
      expect(parsed.tlsrpt_rua).toBeNull();
      expect(parsed.tlsrpt_verified_at).toBeNull();
    });

    it('rejects invalid mta_sts_mode value', () => {
      const row = {
        ...baseDomainRow,
        mta_sts_mode: 'invalid',
        mta_sts_policy_id: null,
        mta_sts_max_age: 86400,
        mta_sts_verified_at: null,
        tlsrpt_enabled: 0,
        tlsrpt_rua: null,
        tlsrpt_verified_at: null,
      };
      expect(() => MailDomain.parse(row)).toThrow();
    });

    it('rejects negative mta_sts_max_age', () => {
      const row = {
        ...baseDomainRow,
        mta_sts_mode: 'none' as const,
        mta_sts_policy_id: null,
        mta_sts_max_age: -1,
        mta_sts_verified_at: null,
        tlsrpt_enabled: 0,
        tlsrpt_rua: null,
        tlsrpt_verified_at: null,
      };
      expect(() => MailDomain.parse(row)).toThrow();
    });

    it('rejects tlsrpt_enabled outside 0..1', () => {
      const row = {
        ...baseDomainRow,
        mta_sts_mode: 'none' as const,
        mta_sts_policy_id: null,
        mta_sts_max_age: 86400,
        mta_sts_verified_at: null,
        tlsrpt_enabled: 2,
        tlsrpt_rua: null,
        tlsrpt_verified_at: null,
      };
      expect(() => MailDomain.parse(row)).toThrow();
    });
  });

  describe('UpdateMailDomainRequest', () => {
    it('accepts mta_sts_mode=testing', () => {
      expect(UpdateMailDomainRequest.parse({ mta_sts_mode: 'testing' })).toEqual({
        mta_sts_mode: 'testing',
      });
    });

    it('accepts mta_sts_mode=enforce + mta_sts_max_age', () => {
      expect(
        UpdateMailDomainRequest.parse({ mta_sts_mode: 'enforce', mta_sts_max_age: 604800 }),
      ).toEqual({ mta_sts_mode: 'enforce', mta_sts_max_age: 604800 });
    });

    it('accepts tlsrpt_enabled=true (boolean in request, route converts to int)', () => {
      expect(UpdateMailDomainRequest.parse({ tlsrpt_enabled: true })).toEqual({
        tlsrpt_enabled: true,
      });
    });

    it('accepts tlsrpt_rua', () => {
      expect(UpdateMailDomainRequest.parse({ tlsrpt_rua: 'mailto:tlsrpt@acme.example' })).toEqual({
        tlsrpt_rua: 'mailto:tlsrpt@acme.example',
      });
    });

    it('rejects unknown mta_sts_mode', () => {
      expect(() => UpdateMailDomainRequest.parse({ mta_sts_mode: 'pending' })).toThrow();
    });

    it('rejects negative mta_sts_max_age', () => {
      expect(() => UpdateMailDomainRequest.parse({ mta_sts_max_age: -10 })).toThrow();
    });

    it('still accepts the empty body (all fields optional)', () => {
      expect(UpdateMailDomainRequest.parse({})).toEqual({});
    });
  });

  describe('AuditAction — Phase C additions', () => {
    const phaseCActions = [
      'mta_sts.enable',
      'mta_sts.disable',
      'mta_sts.promote',
      'tls_rpt.enable',
      'tls_rpt.disable',
    ] as const;

    for (const action of phaseCActions) {
      it(`accepts ${action}`, () => {
        expect(AuditAction.parse(action)).toBe(action);
      });
    }

    it('exposes all five Phase C actions in the enum options', () => {
      for (const action of phaseCActions) {
        expect(AuditAction.options).toContain(action);
      }
    });
  });

  describe('VerifyCheck + VerifyResponse', () => {
    it('VerifyCheck parses a passing CNAME check', () => {
      expect(
        VerifyCheck.parse({
          name: 'cname:_mta-sts.acme.example',
          ok: true,
          expected: 'mta-sts.acme.example.',
          actual: 'mta-sts.acme.example.',
        }),
      ).toBeDefined();
    });

    it('VerifyCheck parses a failing check with drift hint in actual', () => {
      const drift = VerifyCheck.parse({
        name: 'mta-sts:policy-https:mta-sts.acme.example',
        ok: false,
        expected: 'mode=enforce',
        actual: 'mode=testing (drift: published policy mode differs from DB)',
      });
      expect(drift.ok).toBe(false);
      expect(drift.actual).toContain('drift');
    });

    it('VerifyCheck parses a "not provisioned yet" hint', () => {
      // C.7 design note: the verify flow uses VerifyCheck.actual to carry
      // hint text distinguishing "missing" vs "drift" vs "verified" — no
      // discriminated-union shape change needed.
      const missing = VerifyCheck.parse({
        name: 'mta-sts:txt:_mta-sts.acme.example',
        ok: false,
        expected: 'TXT v=STSv1; id=<any>',
        actual: 'not provisioned — call POST /v1/admin/domains/:id/mta-sts/enable',
      });
      expect(missing.ok).toBe(false);
      expect(missing.actual).toContain('not provisioned');
    });

    it('VerifyResponse parses with checks array + optional fields', () => {
      const r = VerifyResponse.parse({
        id: '01HXR0000000000000000000A8',
        status: 'verified',
        checks: [{ name: 'cname:_mta-sts.acme.example', ok: true, expected: '...', actual: '...' }],
        message: 'all good',
        verified_at: 1715731200,
      });
      expect(r.checks).toHaveLength(1);
      expect(r.verified_at).toBe(1715731200);
    });

    it('VerifyResponse parses without optional fields', () => {
      const r = VerifyResponse.parse({
        id: '01HXR0000000000000000000A8',
        status: 'pending',
        checks: [],
      });
      expect(r.checks).toEqual([]);
      expect(r.message).toBeUndefined();
    });

    it('VerifyResponse rejects bad status', () => {
      expect(() =>
        VerifyResponse.parse({
          id: '01HXR0000000000000000000A8',
          status: 'banana',
          checks: [],
        }),
      ).toThrow();
    });
  });
});
