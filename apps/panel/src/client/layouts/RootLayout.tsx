// RootLayout — top-most provider stack mounted once at app boot.
//
// - ThemeProvider: toggles `.dark` on <html>, persists to localStorage.
// - QueryClientProvider: TanStack Query for SDK hooks.
// - TooltipProvider: shadcn/Radix tooltip context.
// - Toaster: sonner toasts.
// - ErrorBoundary: catches uncaught render errors so the whole app doesn't
//   white-screen on a single misbehaving page.
import { Component, createContext, useContext, useEffect, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '../components/ui/sonner.js';
import { TooltipProvider } from '../components/ui/tooltip.js';
import { StepUpModal } from '../components/StepUpModal.js';
import type { StepUpEventDetail } from '../lib/api.js';

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

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 30_000 } },
});

export function RootLayout({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readInitialTheme);
  const [stepUpOpen, setStepUpOpen] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    window.localStorage.setItem('polaris-theme', theme);
  }, [theme]);

  useEffect(() => {
    const handler = (_e: Event): void => {
      // The detail (stepUpUrl) is consumed by the StepUpModal's POST /api/step-up
      // call directly; we just need to open the dialog here.
      setStepUpOpen(true);
    };
    window.addEventListener('stepup:required', handler as EventListener);
    return () => window.removeEventListener('stepup:required', handler as EventListener);
  }, []);

  const setTheme = (t: Theme) => setThemeState(t);

  return (
    <ThemeCtx.Provider value={{ theme, setTheme }}>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={150}>
          <ErrorBoundary>{children}</ErrorBoundary>
          <StepUpModal open={stepUpOpen} onClose={() => setStepUpOpen(false)} />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeCtx.Provider>
  );
}

// Re-export so consumers picking up the symbol from RootLayout don't need a
// separate import path.
export type { StepUpEventDetail };
