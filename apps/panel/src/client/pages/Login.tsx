import { useEffect, useRef, useState } from 'react';
import { PageCard } from '../layouts/PageCard.js';
import { Button } from '../components/ui/button.js';

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
// an IdP ↔ panel bounce loop. Examples observed: ?error=oauth_error,
// ?error=access_denied.
function callbackError(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get('error');
}

export function Login() {
  const [err, setErr] = useState<string | null>(() => callbackError());
  const [pending, setPending] = useState(false);
  const autoTried = useRef(false);

  async function go() {
    setErr(null);
    setPending(true);
    try {
      // eslint-disable-next-line no-console
      console.log('[panel/login] mount at', window.location.href, '— starting sign-in');
      const url = await startSignIn();
      // eslint-disable-next-line no-console
      console.log('[panel/login] navigating to IdP:', url);
      window.location.assign(url);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPending(false);
      // eslint-disable-next-line no-console
      console.error('[panel/login] sign-in error:', e);
    }
  }

  useEffect(() => {
    // Auto-redirect on first mount unless we landed here because of an
    // IdP error. StrictMode double-invokes effects in dev; the ref guards
    // against starting two sign-in flows.
    if (autoTried.current) return;
    autoTried.current = true;
    const e = callbackError();
    if (e) {
      // eslint-disable-next-line no-console
      console.warn('[panel/login] callback error param present, skipping auto-redirect:', e);
      return;
    }
    void go();
  }, []);

  return (
    <PageCard
      title="Sign in"
      description={
        err
          ? 'Sign-in did not complete — retry below or check the IdP configuration.'
          : 'Redirecting to your identity provider…'
      }
    >
      <Button onClick={go} disabled={pending}>
        {pending ? 'Redirecting…' : err ? 'Retry SSO' : 'Continue with SSO'}
      </Button>
      {err ? <p className="mt-2 text-sm text-destructive">{err}</p> : null}
    </PageCard>
  );
}
