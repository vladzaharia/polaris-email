// Thin TanStack Query wrappers around the panel's /api/admin/* proxy.
//
// The generated @polaris/sdk/react hooks aren't ready for every endpoint yet
// (the codegen output is currently empty); these hand-rolled hooks fill the
// gap. Once the codegen catches up, replace each one and update the
// import-callsite (see `// TODO: replace with generated hook`).
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { apiFetch } from '../lib/api.js';

// TODO: replace with generated hook
export interface Envelope<T> {
  data: T;
}

export function useAdminQuery<T>(
  key: readonly unknown[],
  path: string,
  options: { enabled?: boolean } = {},
): UseQueryResult<T, Error> {
  return useQuery<T, Error>({
    queryKey: key,
    queryFn: async () => {
      const r = await apiFetch<T>(path);
      if (r.status >= 400) {
        throw new Error(
          (r.body as { message?: string; error?: string })?.message ??
            (r.body as { error?: string })?.error ??
            `HTTP ${r.status}`,
        );
      }
      return r.body;
    },
    enabled: options.enabled ?? true,
  });
}

export function useAdminMutation<T, V = unknown>(
  path: (vars: V) => { path: string; method?: string; body?: unknown },
  options: { invalidateKeys?: readonly unknown[][] } = {},
): ReturnType<typeof useMutation<T, Error, V>> {
  const qc = useQueryClient();
  return useMutation<T, Error, V>({
    mutationFn: async (vars: V) => {
      const cfg = path(vars);
      const r = await apiFetch<T>(cfg.path, {
        method: cfg.method ?? 'POST',
        body: cfg.body == null ? undefined : JSON.stringify(cfg.body),
      });
      if (r.status >= 400) {
        throw new Error(
          (r.body as { message?: string; error?: string })?.message ??
            (r.body as { error?: string })?.error ??
            `HTTP ${r.status}`,
        );
      }
      return r.body;
    },
    onSuccess: () => {
      for (const k of options.invalidateKeys ?? []) {
        void qc.invalidateQueries({ queryKey: k });
      }
    },
  });
}
