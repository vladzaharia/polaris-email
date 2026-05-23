// useAuthError — maps an OIDC / better-auth callback error code into the
// shape Login.tsx renders inside a shadcn <Alert>.
//
// Better-auth's failure path is `302 /api/auth/error?error=<code>` (panel
// server intercepts that and forwards to `/login?error=<code>`). On top of
// the better-auth codes we mint a few synthetic ones the client itself
// raises (network failure, IdP unreachable, redirect-loop guard tripped,
// admin-group check failed).
//
// `mapAuthError` is a pure function — the hook is a thin URL-search wrapper
// for the route component. Tests target the pure function.

export type AuthErrorVariant = 'destructive' | 'warning' | 'info';

export interface AuthErrorInfo {
  /** The raw code that was matched (or 'unknown'). Surfaced in the <details>. */
  code: string;
  title: string;
  description: string;
  variant: AuthErrorVariant;
  /** Whether the primary CTA should be "Try again" vs. "Contact your administrator". */
  retryable: boolean;
  /** Whether to render the secondary "Contact your administrator" affordance. */
  showContactAdmin: boolean;
  /** Whether to render the "Clear and reload" affordance (loop recovery). */
  showClearAndReload: boolean;
}

interface CodeEntry {
  title: string;
  description: string;
  variant: AuthErrorVariant;
  retryable: boolean;
  showContactAdmin: boolean;
  showClearAndReload: boolean;
}

// Keep the table close to the type so additions stay self-documenting.
const CODES: Record<string, CodeEntry> = {
  please_restart_the_process: {
    title: 'Sign-in session expired',
    description: 'The login attempt timed out or used a stale tab. Try again.',
    variant: 'warning',
    retryable: true,
    showContactAdmin: false,
    showClearAndReload: false,
  },
  invalid_state: {
    title: 'Stale tab',
    description: 'Open Polaris Mail in a single tab and try again.',
    variant: 'warning',
    retryable: true,
    showContactAdmin: false,
    showClearAndReload: false,
  },
  access_denied: {
    title: 'Identity provider denied sign-in',
    description: 'Polaris ID rejected the request. Check that your account is enabled.',
    variant: 'destructive',
    retryable: true,
    showContactAdmin: true,
    showClearAndReload: false,
  },
  invalid_request: {
    title: 'Sign-in handshake failed',
    description: 'Clear cookies for this site and try again.',
    variant: 'destructive',
    retryable: true,
    showContactAdmin: false,
    showClearAndReload: true,
  },
  oauth_code_verification_failed: {
    title: 'Sign-in handshake failed',
    description: 'Clear cookies for this site and try again.',
    variant: 'destructive',
    retryable: true,
    showContactAdmin: false,
    showClearAndReload: true,
  },
  network: {
    title: "Can't reach the panel",
    description: 'Network or panel Worker is unreachable. Retry; if it persists, check status.',
    variant: 'warning',
    retryable: true,
    showContactAdmin: false,
    showClearAndReload: false,
  },
  idp_unreachable: {
    title: 'Polaris ID is unreachable',
    description: "We couldn't reach the identity provider. Retry in a moment.",
    variant: 'warning',
    retryable: true,
    showContactAdmin: false,
    showClearAndReload: false,
  },
  group_not_allowed: {
    title: "Account isn't authorized",
    description:
      "You signed in to Polaris ID, but your account isn't in the required admin group. " +
      'Ask your administrator to add you, then try again.',
    variant: 'destructive',
    retryable: true,
    showContactAdmin: true,
    showClearAndReload: false,
  },
  expired: {
    title: 'Session expired',
    description: 'Your session expired. Sign in again to continue.',
    variant: 'info',
    retryable: true,
    showContactAdmin: false,
    showClearAndReload: false,
  },
  loop_detected: {
    title: 'We bounced you back without signing you in',
    description:
      'Sign-in keeps failing immediately. Try again, or clear panel cookies if it persists.',
    variant: 'warning',
    retryable: true,
    showContactAdmin: false,
    showClearAndReload: true,
  },
  unknown: {
    title: "Sign-in didn't complete",
    description:
      'Something went wrong. Try again or share the error code below with your administrator.',
    variant: 'destructive',
    retryable: true,
    showContactAdmin: true,
    showClearAndReload: false,
  },
};

export function mapAuthError(code: string | null | undefined): AuthErrorInfo | null {
  if (typeof code !== 'string' || code.length === 0) return null;
  // The `unknown` key is statically guaranteed to be in the table; the
  // non-null assertion satisfies `noUncheckedIndexedAccess`.
  const entry: CodeEntry = CODES[code] ?? CODES.unknown!;
  return { code, ...entry };
}

/**
 * Reads `?error=…` from `window.location.search` once at mount and returns
 * the mapped error info (or null). Re-runs only on full reload — the login
 * page is a single-shot surface, so we deliberately don't watch for changes.
 */
export function useAuthError(): AuthErrorInfo | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  return mapAuthError(params.get('error'));
}
