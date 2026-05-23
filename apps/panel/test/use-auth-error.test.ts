import { describe, expect, it } from 'vitest';
import { mapAuthError, type AuthErrorVariant } from '../src/client/hooks/useAuthError.js';

describe('mapAuthError', () => {
  it('returns null for missing / empty input', () => {
    expect(mapAuthError(null)).toBeNull();
    expect(mapAuthError(undefined)).toBeNull();
    expect(mapAuthError('')).toBeNull();
  });

  // Table-driven coverage of every documented code. Update this table when
  // adding/removing codes in useAuthError.ts — the test should be the
  // forcing function that keeps copy + variant decisions intentional.
  const cases: Array<{
    code: string;
    variant: AuthErrorVariant;
    titleContains: string;
    retryable: boolean;
    showContactAdmin: boolean;
    showClearAndReload: boolean;
  }> = [
    {
      code: 'please_restart_the_process',
      variant: 'warning',
      titleContains: 'expired',
      retryable: true,
      showContactAdmin: false,
      showClearAndReload: false,
    },
    {
      code: 'invalid_state',
      variant: 'warning',
      titleContains: 'Stale',
      retryable: true,
      showContactAdmin: false,
      showClearAndReload: false,
    },
    {
      code: 'access_denied',
      variant: 'destructive',
      titleContains: 'denied',
      retryable: true,
      showContactAdmin: true,
      showClearAndReload: false,
    },
    {
      code: 'invalid_request',
      variant: 'destructive',
      titleContains: 'handshake',
      retryable: true,
      showContactAdmin: false,
      showClearAndReload: true,
    },
    {
      code: 'oauth_code_verification_failed',
      variant: 'destructive',
      titleContains: 'handshake',
      retryable: true,
      showContactAdmin: false,
      showClearAndReload: true,
    },
    {
      code: 'network',
      variant: 'warning',
      titleContains: 'reach the panel',
      retryable: true,
      showContactAdmin: false,
      showClearAndReload: false,
    },
    {
      code: 'idp_unreachable',
      variant: 'warning',
      titleContains: 'Polaris ID is unreachable',
      retryable: true,
      showContactAdmin: false,
      showClearAndReload: false,
    },
    {
      code: 'group_not_allowed',
      variant: 'destructive',
      titleContains: 'authorized',
      retryable: true,
      showContactAdmin: true,
      showClearAndReload: false,
    },
    {
      code: 'expired',
      variant: 'info',
      titleContains: 'expired',
      retryable: true,
      showContactAdmin: false,
      showClearAndReload: false,
    },
    {
      code: 'loop_detected',
      variant: 'warning',
      titleContains: 'bounced',
      retryable: true,
      showContactAdmin: false,
      showClearAndReload: true,
    },
    {
      code: 'unknown',
      variant: 'destructive',
      titleContains: "didn't complete",
      retryable: true,
      showContactAdmin: true,
      showClearAndReload: false,
    },
  ];

  for (const c of cases) {
    it(`maps ${c.code}`, () => {
      const info = mapAuthError(c.code);
      expect(info).not.toBeNull();
      expect(info?.code).toBe(c.code);
      expect(info?.variant).toBe(c.variant);
      expect(info?.title).toContain(c.titleContains);
      expect(info?.retryable).toBe(c.retryable);
      expect(info?.showContactAdmin).toBe(c.showContactAdmin);
      expect(info?.showClearAndReload).toBe(c.showClearAndReload);
    });
  }

  it('routes unknown codes through the unknown mapping but preserves the raw code', () => {
    const info = mapAuthError('totally_made_up_code');
    expect(info).not.toBeNull();
    expect(info?.code).toBe('totally_made_up_code');
    expect(info?.title).toContain("didn't complete");
    expect(info?.variant).toBe('destructive');
  });
});
