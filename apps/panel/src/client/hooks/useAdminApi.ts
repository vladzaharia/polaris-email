// Thin TanStack Query wrappers around the panel's /api/admin/* proxy.
//
// Hand-rolled rather than codegen-driven: the `@polaris/sdk/react` hook
// generator isn't wired up, and these wrappers are thin enough that
// hand-rolling stays cheaper than maintaining a generator template.
//
// Errors:
//  - `apiFetch` now throws a typed `ApiError` on non-2xx responses
//    (`code`/`status`/`requestId`/`retryable`). The TanStack Query error
//    channel sees `ApiError` directly — no manual `r.status >= 400` checks
//    in caller code.
//
// Toasts:
//  - `useAdminMutation` wires `sonner` for both success and error feedback.
//    Pass `silent: true` to opt out (e.g. for mutations whose UI already
//    shows the result inline, like the credential rotate flow that opens
//    `SecretRevealDialog`).
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiFetch, ApiError } from '../lib/api.js';

export interface Envelope<T> {
  data: T;
}

export function useAdminQuery<T>(
  key: readonly unknown[],
  path: string,
  options: { enabled?: boolean; staleTime?: number; refetchInterval?: number } = {},
): UseQueryResult<T, ApiError> {
  return useQuery<T, ApiError>({
    queryKey: key,
    queryFn: async () => {
      const r = await apiFetch<T>(path);
      return r.body;
    },
    enabled: options.enabled ?? true,
    staleTime: options.staleTime,
    refetchInterval: options.refetchInterval,
    retry: (failureCount, err) => {
      // Don't burn retries on 4xx — they won't succeed on the next try.
      if (err instanceof ApiError && err.status < 500 && err.status !== 429) return false;
      return failureCount < 2;
    },
  });
}

export interface AdminMutationOptions {
  /**
   * Query keys to invalidate on success. Accepts readonly arrays so the
   * factory keys from `queryKeys.ts` (which are `as const` tuples) drop
   * straight in.
   */
  invalidateKeys?: ReadonlyArray<readonly unknown[]>;
  /** Override the default success toast text. */
  successMessage?: string;
  /** Suppress success/error toasts entirely. */
  silent?: boolean;
}

function defaultSuccessMessage(method: string): string {
  switch (method.toUpperCase()) {
    case 'DELETE':
      return 'Deleted.';
    case 'PATCH':
    case 'PUT':
      return 'Saved.';
    case 'POST':
    default:
      return 'Done.';
  }
}

export function useAdminMutation<T, V = unknown>(
  path: (vars: V) => { path: string; method?: string; body?: unknown },
  options: AdminMutationOptions = {},
): ReturnType<typeof useMutation<T, ApiError, V>> {
  const qc = useQueryClient();
  return useMutation<T, ApiError, V>({
    mutationFn: async (vars: V) => {
      const cfg = path(vars);
      const r = await apiFetch<T>(cfg.path, {
        method: cfg.method ?? 'POST',
        body: cfg.body == null ? undefined : JSON.stringify(cfg.body),
      });
      return r.body;
    },
    onSuccess: (_data, vars) => {
      for (const k of options.invalidateKeys ?? []) {
        void qc.invalidateQueries({ queryKey: k });
      }
      if (!options.silent) {
        const cfg = path(vars);
        toast.success(options.successMessage ?? defaultSuccessMessage(cfg.method ?? 'POST'));
      }
    },
    onError: (err) => {
      if (options.silent) return;
      const message = err.message || 'Something went wrong';
      toast.error(message);
    },
  });
}
