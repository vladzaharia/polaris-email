import { useState } from 'react';
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

export function Login() {
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onClick() {
    setErr(null);
    setPending(true);
    try {
      const url = await startSignIn();
      window.location.assign(url);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPending(false);
    }
  }

  return (
    <PageCard title="Sign in" description="OIDC via Cloudflare Access (or another configured IdP).">
      <Button onClick={onClick} disabled={pending}>
        {pending ? 'Redirecting…' : 'Continue with SSO'}
      </Button>
      {err ? <p className="mt-2 text-sm text-destructive">{err}</p> : null}
    </PageCard>
  );
}
