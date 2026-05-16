// RootLayout — top-most provider stack mounted once at app boot.
//
// - ThemeProvider: toggles `.dark` on <html>, persists to localStorage.
// - QueryClientProvider: TanStack Query for SDK hooks.
// - TooltipProvider: shadcn/Radix tooltip context.
// - Toaster: sonner toasts. `useAdminMutation` (and ad-hoc callers) push
//   success/error feedback through this.
// - ErrorBoundary: catches uncaught render errors so the whole app doesn't
//   white-screen on a single misbehaving page.
//
// Note: the panel does not implement a self-elevation step-up flow. The
// backend gates destructive actions on the two-person `withApproval` flow
// and returns 428 with `{ code: 'approval_required' }` when an approved
// approval-id header is missing. The mutation toast wiring in
// `useAdminApi.ts` renders the friendly message.
import { Component, createContext, useContext, useEffect, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '../components/ui/sonner.js';
import { TooltipProvider } from '../components/ui/tooltip.js';
import { ApiError } from '../lib/api.js';

type Theme = 'light' | 'dark';

const ThemeCtx = createContext<{ theme: Theme; setTheme: (t: Theme) => void }>({
  theme: 'light',
  setTheme: () => undefined,
});

export function useTheme() {
  return useContext(ThemeCtx);
}

function readInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'light';
  const stored = window.localStorage.getItem('polaris-theme');
  if (stored === 'dark' || stored === 'light') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

class ErrorBoundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  override state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) {
    return { err };
  }
  override componentDidCatch(err: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('panel render error', err, info.componentStack);
  }
  override render() {
    if (this.state.err) {
      return (
        <div className="p-8">
          <h1 className="text-lg font-semibold">Something broke.</h1>
          <pre className="mt-4 whitespace-pre-wrap text-xs">
            {String(this.state.err.stack ?? this.state.err.message)}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

// Retry policy:
//  - 4xx errors are deterministic — re-firing the same request will return
//    the same status, so don't waste a round trip.
//  - 429 (rate-limited) and 5xx errors might recover; allow up to 3 retries
//    so an in-flight backend restart doesn't surface to the operator.
//  - Network errors (no `instanceof ApiError`) follow the same retry budget.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      retry: (failureCount, error) => {
        if (
          error instanceof ApiError &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 429
        ) {
          return false;
        }
        return failureCount < 3;
      },
    },
  },
});

export function RootLayout({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readInitialTheme);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    window.localStorage.setItem('polaris-theme', theme);
  }, [theme]);

  const setTheme = (t: Theme) => setThemeState(t);

  return (
    <ThemeCtx.Provider value={{ theme, setTheme }}>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={150}>
          <ErrorBoundary>{children}</ErrorBoundary>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeCtx.Provider>
  );
}
