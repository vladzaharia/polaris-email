import { useEffect, useRef, useState } from 'react';
import { PageCard } from '../layouts/PageCard.js';
import { Button } from '../components/ui/button.js';
import { ErrorText } from '../components/ErrorText.js';

// Better-auth's genericOAuth plugin exposes sign-in at
// POST /api/auth/sign-in/social with the configured providerId. The
// response carries `{url, redirect: true}` pointing at the IdP's
// authorize endpoint, which we navigate to. The previous link form
// (`/api/auth/sign-in/sso?provider=default`) targeted an endpoint
// better-auth never exposed and silently 404'd, leaving operators
// stranded on /login.
async function startSignIn(): Promise<string> {
  const res = await fetch('/api/auth/sign-in/social', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'oidc' }),
    credentials: 'include',
  });
  if (!res.ok) {
    throw new Error(`sign-in: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { url?: string };
  if (!body.url) {
    throw new Error('sign-in: no redirect URL returned');
  }
  return body.url;
}

// URL params better-auth may set on a failed callback. When present we
// skip auto-redirect and surface the message so the user isn't stuck in
// an IdP ↔ panel bounce loop. Forwarded from /api/auth/error by the
// panel server (see src/server/index.ts).
function callbackError(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get('error') ?? params.get('error_description');
}

// Translate better-auth's error codes into operator-friendly copy.
// Unknown codes pass through as-is — surfacing the raw code is better
// than swallowing it during the first round of post-bring-up issues.
function friendlyError(code: string): string {
  switch (code) {
    case 'please_restart_the_process':
      return "Sign-in didn't complete (stale code or state mismatch). Try again.";
    case 'access_denied':
      return 'The identity provider denied the sign-in request.';
    case 'invalid_state':
      return 'Sign-in state mismatch — possibly a stale tab. Try again.';
    case 'invalid_request':
      return 'Bad sign-in request — clear cookies for this site and try again.';
    case 'unknown':
      return "Sign-in didn't complete. Try again.";
    default:
      return `Sign-in failed (${code}).`;
  }
}

// Cross-mount loop guard. If we auto-redirected to the IdP recently,
// don't do it again unprompted — better-auth might have redirected back
// through a path that doesn't carry an `?error` param. After this many
// milliseconds, the timestamp is considered stale and a fresh /login
// visit auto-redirects normally (sign-out → sign-in works).
const AUTO_ATTEMPT_KEY = 'panel.lastAutoSignInAt';
const AUTO_ATTEMPT_GUARD_MS = 5_000;

function recentAutoAttempt(): boolean {
  try {
    const v = sessionStorage.getItem(AUTO_ATTEMPT_KEY);
    if (!v) return false;
    const ms = Date.now() - Number.parseInt(v, 10);
    return Number.isFinite(ms) && ms < AUTO_ATTEMPT_GUARD_MS;
  } catch {
    return false;
  }
}

function markAttempt(): void {
  try {
    sessionStorage.setItem(AUTO_ATTEMPT_KEY, String(Date.now()));
  } catch {
    // sessionStorage may be unavailable in private mode; fail open —
    // the user can still drive the flow manually.
  }
}

export function Login() {
  const [err, setErr] = useState<string | null>(() => {
    const e = callbackError();
    return e ? friendlyError(e) : null;
  });
  const [pending, setPending] = useState(false);
  const autoTried = useRef(false);

  async function go() {
    setErr(null);
    setPending(true);
    markAttempt();
    try {
      const url = await startSignIn();
      window.location.assign(url);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPending(false);
    }
  }

  useEffect(() => {
    // Auto-redirect on first mount UNLESS:
    //   (a) we landed with an `?error` param (better-auth callback failure,
    //       forwarded from /api/auth/error by the panel server), OR
    //   (b) we auto-redirected very recently — almost certainly a loop
    //       (e.g. the IdP bounced us back without an error code), so
    //       fall back to the manual button instead of looping forever.
    // The ref guards StrictMode double-invocation within a single mount.
    if (autoTried.current) return;
    autoTried.current = true;
    if (callbackError()) return;
    if (recentAutoAttempt()) {
      setErr("Sign-in didn't complete on the previous attempt. Click below to try again.");
      return;
    }
    void go();
  }, []);

  return (
    <PageCard
      title="Sign in"
      description={
        err
          ? 'Sign-in did not complete. Retry below.'
          : pending
            ? 'Redirecting to your identity provider…'
            : 'OIDC via Cloudflare Access (or another configured IdP).'
      }
    >
      <Button onClick={go} disabled={pending}>
        {pending ? 'Redirecting…' : err ? 'Try again' : 'Continue with SSO'}
      </Button>
      <ErrorText error={err} className="mt-2" />
    </PageCard>
  );
}
