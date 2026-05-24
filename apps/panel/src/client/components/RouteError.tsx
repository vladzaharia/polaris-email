// RouteError — per-route fallback used by TanStack Router's `errorComponent`.
//
// Renders a compact card with the underlying message + request-id (when the
// error is an `ApiError`) and a "Reload" button. The reload calls
// `window.location.reload()` rather than `router.invalidate()` because some
// errors come from the route's `component` itself — re-running the load
// without unmounting won't always recover. Hard reload is the safe default.
import { AlertTriangle } from 'lucide-react';
import { Button } from './ui/button.js';
import { ApiError } from '../lib/api.js';

export function RouteError({ error }: { error: unknown }) {
  let message = error instanceof Error ? error.message : String(error);
  let requestId: string | null = null;
  let status: number | null = null;
  if (error instanceof ApiError) {
    requestId = error.requestId;
    status = error.status;
  }
  return (
    <div className="m-6 max-w-2xl rounded-md border border-[var(--color-destructive)] bg-[var(--color-destructive)]/5 p-6">
      <div className="flex items-start gap-3">
        <AlertTriangle
          className="mt-1 h-5 w-5 shrink-0 text-[var(--color-destructive)]"
          aria-hidden
        />
        <div className="flex-1">
          <h2 className="text-base font-semibold text-[var(--color-destructive)]">
            Something went wrong loading this page.
          </h2>
          <p className="mt-2 text-sm">{message}</p>
          {status != null ? (
            <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">HTTP {status}</p>
          ) : null}
          {requestId ? (
            <p className="mt-1 font-mono text-xs text-[var(--color-muted-foreground)]">
              request_id: {requestId}
            </p>
          ) : null}
          <div className="mt-4">
            <Button size="sm" onClick={() => window.location.reload()}>
              Reload
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
