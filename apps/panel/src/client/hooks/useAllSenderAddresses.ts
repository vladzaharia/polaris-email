// Aggregated sender-address list for the AddressCombobox.
//
// There is no flat /v1/admin/senders endpoint — each mailbox's senders ship
// inside its detail payload. We fan out (N+1: one list call + N parallel
// detail calls) and dedupe addresses into a flat string[]. N is bounded by
// `active_sender_count > 0` mailboxes — for the panel's expected scale
// (≤50 mailboxes) this is fine. Caching is 5min so navigating between
// pages that mount the combobox doesn't re-fan-out.
//
// Pages that want suggestions just call this hook and pipe `.data` into
// `<AddressCombobox suggestions={[{ label: 'Mailbox senders', addresses }]} />`.
import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { apiFetch, ApiError } from '../lib/api.js';
import { mailboxKeys } from '../queryKeys.js';

const STALE = 5 * 60_000;

interface MailboxListRow {
  id: string;
  name: string;
  active_sender_count?: number;
  disabled_at?: string | null;
}

interface MailboxDetailPayload {
  senders?: Array<{ address: string; disabled_at: string | null }>;
}

export function useAllSenderAddresses(): { data: string[]; isLoading: boolean } {
  const list = useQuery<{ data: MailboxListRow[] }, ApiError>({
    queryKey: mailboxKeys.list(),
    queryFn: async () => (await apiFetch<{ data: MailboxListRow[] }>('/api/admin/mailboxes')).body,
    staleTime: STALE,
  });

  const ids = useMemo(() => {
    const rows = list.data?.data ?? [];
    return rows.filter((m) => !m.disabled_at && (m.active_sender_count ?? 0) > 0).map((m) => m.id);
  }, [list.data]);

  const details = useQueries({
    queries: ids.map((id) => ({
      queryKey: mailboxKeys.detail(id),
      queryFn: async (): Promise<MailboxDetailPayload> =>
        (await apiFetch<MailboxDetailPayload>(`/api/admin/mailboxes/${id}`)).body,
      staleTime: STALE,
    })),
  });

  const addresses = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const d of details) {
      const senders = d.data?.senders ?? [];
      for (const s of senders) {
        if (s.disabled_at) continue;
        const key = s.address.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(s.address);
      }
    }
    out.sort((a, b) => a.localeCompare(b));
    return out;
  }, [details]);

  const isLoading = list.isLoading || details.some((d) => d.isLoading);
  return { data: addresses, isLoading };
}
