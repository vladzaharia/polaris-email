// ErrorText — renders a destructive-coloured error message and, when given
// an `ApiError`, surfaces the request id so operators can grep server logs.
//
// Replaces the ~14 ad-hoc `<p className="text-sm text-destructive">` blocks
// in pages so the formatting is consistent (and so a future redesign of how
// errors render touches one component, not 14).
import { ApiError } from '../lib/api.js';
import { cn } from '../lib/cn.js';

export interface ErrorTextProps {
  error: ApiError | Error | string | null | undefined;
  className?: string;
}

export function ErrorText({ error, className }: ErrorTextProps) {
  if (!error) return null;
  const message = typeof error === 'string' ? error : error.message;
  const requestId = error instanceof ApiError ? error.requestId : null;
  return (
    <p className={cn('text-sm text-[var(--color-destructive)]', className)} role="alert">
      {message}
      {requestId ? (
        <span className="ml-2 font-mono text-xs opacity-70">request_id={requestId}</span>
      ) : null}
    </p>
  );
}
