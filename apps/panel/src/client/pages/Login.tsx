// /login — the panel's only unauthenticated route.
//
// Single auth method: Polaris ID (OIDC), wired through better-auth's
// genericOAuth plugin (provider id 'oidc'). No signup, no password, no
// alternate providers.
//
// UX contract:
//   • On mount, render the card immediately and auto-submit after a 300ms
//     grace window. The grace is short enough that the happy path still
//     feels instant, but long enough that an operator can hit Cancel before
//     they're handed off to the IdP. (3am-pager ergonomics vs.
//     debugging-a-loop ergonomics, both served.)
//   • If `?error=` is present, OR the loop guard tripped, skip auto-submit
//     and render the idle card with a friendly Alert + manual retry.
//   • Errors render through `useAuthError` → shadcn Alert; the raw code,
//     IdP `error_description`, and a generated correlation_id sit behind a
//     `<details>` so operators can paste them into a bug report.
//   • `?next=` is sanitised via safeNext() and forwarded to better-auth as
//     `callbackURL`, so deep links survive the OIDC round-trip.
import { useEffect, useRef, useState } from 'react';
import { Loader2, Mail } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.js';
import { Button } from '../components/ui/button.js';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/ui/card.js';
import { mapAuthError, type AuthErrorInfo } from '../hooks/useAuthError.js';
import {
  recordAttempt as recordSignInAttempt,
  reset as resetLoopGuard,
  shouldAutoSubmit as canAutoSubmit,
} from '../hooks/useSignInLoopGuard.js';
import { safeNext } from '../lib/safe-next.js';

const GRACE_MS = 300;

type Phase = 'pending' | 'idle';

interface UrlParams {
  error: string | null;
  errorDescription: string | null;
  next: string | null;
}

function readUrl(): UrlParams {
  if (typeof window === 'undefined') return { error: null, errorDescription: null, next: null };
  const p = new URLSearchParams(window.location.search);
  return {
    error: p.get('error'),
    errorDescription: p.get('error_description'),
    next: p.get('next'),
  };
}

function initialPhaseAndError(url: UrlParams): { phase: Phase; error: AuthErrorInfo | null } {
  const fromUrl = mapAuthError(url.error);
  if (fromUrl) return { phase: 'idle', error: fromUrl };
  if (typeof window !== 'undefined' && !canAutoSubmit(window.sessionStorage)) {
    return { phase: 'idle', error: mapAuthError('loop_detected') };
  }
  return { phase: 'pending', error: null };
}

export function Login() {
  // URL params are read-once — /login is a single-shot surface. Stashing
  // them in a ref prevents accidental coupling to a non-existent route
  // search schema (we still rely on raw query strings for the OIDC error
  // codes better-auth forwards through /api/auth/error).
  const urlRef = useRef<UrlParams>(readUrl());
  const url = urlRef.current;
  const validNext = safeNext(url.next);

  const [{ phase, error }, setState] = useState<{
    phase: Phase;
    error: AuthErrorInfo | null;
  }>(() => initialPhaseAndError(url));

  const correlationIdRef = useRef<string>(String(Date.now()));
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const startedRef = useRef(false);

  function clearPendingFetch() {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (controllerRef.current) {
      controllerRef.current.abort();
      controllerRef.current = null;
    }
  }

  function schedule() {
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      void startSignIn();
    }, GRACE_MS);
  }

  async function startSignIn() {
    if (typeof window === 'undefined') return;
    recordSignInAttempt(window.sessionStorage);
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const res = await fetch('/api/auth/sign-in/social', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          provider: 'oidc',
          callbackURL: validNext ?? '/',
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        setState({
          phase: 'idle',
          error: mapAuthError(res.status >= 500 ? 'idp_unreachable' : 'unknown'),
        });
        return;
      }
      const body = (await res.json()) as { url?: string };
      if (!body.url) {
        setState({ phase: 'idle', error: mapAuthError('unknown') });
        return;
      }
      window.location.assign(body.url);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      // TypeError covers DNS failures, CORS, offline. Everything else falls
      // through to the generic unknown bucket — surfaced raw in <details>.
      setState({
        phase: 'idle',
        error: mapAuthError(e instanceof TypeError ? 'network' : 'unknown'),
      });
    } finally {
      controllerRef.current = null;
    }
  }

  function go() {
    correlationIdRef.current = String(Date.now());
    setState({ phase: 'pending', error: null });
    schedule();
  }

  function cancel() {
    clearPendingFetch();
    setState({ phase: 'idle', error: null });
  }

  async function clearAndReload() {
    clearPendingFetch();
    try {
      await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'same-origin' });
    } catch {
      // Ignore — we're about to navigate away regardless.
    }
    if (typeof window !== 'undefined') {
      resetLoopGuard(window.sessionStorage);
      window.location.replace('/login');
    }
  }

  useEffect(() => {
    // StrictMode runs effects twice on dev mount; the ref keeps us
    // idempotent within a single effective mount.
    if (startedRef.current) return;
    startedRef.current = true;
    if (phase === 'pending') schedule();
    return () => clearPendingFetch();
    // The initial phase is captured at mount; intentionally not re-running.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-background)] px-4 py-12">
      <div className="flex w-full max-w-md flex-col items-center gap-6">
        {/* Brand mark — mirrors the sidebar header (AppSidebar.tsx)
            so the operator sees the same lockup on the way in as in
            the chrome they'll spend the rest of their session in. */}
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-md bg-[var(--color-primary)] text-[var(--color-primary-foreground)]">
            <Mail className="h-5 w-5" aria-hidden />
          </div>
          <div className="text-xl font-semibold tracking-tight text-[var(--color-foreground)]">
            Polaris Mail
          </div>
        </div>
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
            <CardDescription>Use your Polaris ID to access the admin panel.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {error ? (
              <Alert variant={error.variant}>
                <AlertTitle>{error.title}</AlertTitle>
                <AlertDescription>{error.description}</AlertDescription>
                <details className="mt-2 text-xs text-[var(--color-muted-foreground)]">
                  <summary className="cursor-pointer select-none">Diagnostic detail</summary>
                  <div className="mt-1 grid gap-0.5 font-mono">
                    <div>
                      error: <span className="text-[var(--color-foreground)]">{error.code}</span>
                    </div>
                    {url.errorDescription ? (
                      <div>
                        error_description:{' '}
                        <span className="text-[var(--color-foreground)]">
                          {url.errorDescription}
                        </span>
                      </div>
                    ) : null}
                    <div>
                      correlation_id:{' '}
                      <span className="text-[var(--color-foreground)]">
                        {correlationIdRef.current}
                      </span>
                    </div>
                  </div>
                </details>
              </Alert>
            ) : null}

            {phase === 'pending' ? (
              <div className="flex flex-col gap-3">
                <div
                  role="status"
                  aria-live="polite"
                  className="flex items-center justify-center gap-2 text-sm text-[var(--color-muted-foreground)]"
                >
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  <span>Redirecting to Polaris ID…</span>
                </div>
                <Button key="cancel" variant="ghost" autoFocus onClick={cancel} className="w-full">
                  Cancel
                </Button>
              </div>
            ) : (
              <Button key="primary" autoFocus onClick={go} className="w-full">
                {error ? 'Try again' : 'Continue with Polaris ID'}
              </Button>
            )}

            {error?.showClearAndReload ? (
              <Button variant="outline" onClick={clearAndReload} className="w-full">
                Clear and reload
              </Button>
            ) : null}

            {validNext ? (
              <p className="text-center text-xs text-[var(--color-muted-foreground)]">
                You&apos;ll return to{' '}
                <code className="font-mono text-[var(--color-foreground)]">{validNext}</code> after
                signing in.
              </p>
            ) : null}

            {error?.showContactAdmin ? (
              <p className="text-center text-xs text-[var(--color-muted-foreground)]">
                Need access? Contact your administrator.
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
