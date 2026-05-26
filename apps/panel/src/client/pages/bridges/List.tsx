// Bridges list.
//
// Liveness column reads the new server-computed enum
// (`live`/`stale`/`offline`) and renders it as a StatusBadge. Default
// sort puts offline + never-seen bridges last by ordering on
// `last_seen_at DESC` client-side; the API also returns them by name so
// the secondary order is stable.
//
// Registration is a 3-step wizard; see ./RegistrationWizard.tsx.
import { Link } from '@tanstack/react-router';
import { PageCard } from '../../layouts/PageCard.js';
import { PaginatedTable } from '../../components/PaginatedTable.js';
import { StatusBadge } from '../../components/StatusBadge.js';
import { ErrorText } from '../../components/ErrorText.js';
import { useAdminQuery } from '../../hooks/useAdminApi.js';
import { bridgeKeys } from '../../queryKeys.js';
import { formatDate, formatRelative } from '../../lib/format.js';
import { AddBridgeDialog } from './RegistrationWizard.js';

interface BridgeRow {
  id: string;
  name: string;
  last_seen_at: string | null;
  created_at: string;
  disabled_at: string | null;
  bridge_version: string | null;
  liveness: 'live' | 'stale' | 'offline';
  serves_mailboxes: number;
}

function sortRows(rows: readonly BridgeRow[]): BridgeRow[] {
  // Live > stale > offline; within a bucket, most-recently-seen first.
  // Disabled bridges always sink to the bottom regardless of liveness.
  const rank = (r: BridgeRow): number => {
    if (r.disabled_at) return 3;
    if (r.liveness === 'live') return 0;
    if (r.liveness === 'stale') return 1;
    return 2;
  };
  return [...rows].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    const ta = a.last_seen_at ? Date.parse(a.last_seen_at) : 0;
    const tb = b.last_seen_at ? Date.parse(b.last_seen_at) : 0;
    return tb - ta;
  });
}

export function BridgesList() {
  const q = useAdminQuery<{ data: BridgeRow[] }>(bridgeKeys.list(), '/api/admin/bridges');
  const rows = sortRows(q.data?.data ?? []);
  return (
    <PageCard
      title="Bridges"
      description="On-prem SMTP/IMAP bridges"
      decorative
      actions={<AddBridgeDialog />}
    >
      {q.error ? (
        <ErrorText error={q.error} />
      ) : (
        <PaginatedTable<BridgeRow>
          caption="Registered on-prem bridges and their latest heartbeat."
          loading={q.isLoading}
          rows={rows}
          empty="No bridges registered."
          rowKey={(d) => d.id}
          columns={[
            {
              key: 'name',
              header: 'Name',
              cell: (d) => (
                <Link to="/bridges/$id" params={{ id: d.id }} className="underline">
                  {d.name}
                </Link>
              ),
            },
            {
              key: 'liveness',
              header: 'Liveness',
              cell: (d) =>
                d.disabled_at ? (
                  <StatusBadge kind="bridge" value="disabled" />
                ) : (
                  <StatusBadge kind="bridge" value={d.liveness} />
                ),
            },
            {
              key: 'last_seen_at',
              header: 'Last seen',
              className: 'text-xs',
              cell: (d) => (
                <span title={d.last_seen_at ? formatDate(d.last_seen_at) : undefined}>
                  {formatRelative(d.last_seen_at)}
                </span>
              ),
            },
            {
              key: 'bridge_version',
              header: 'Version',
              className: 'text-xs font-mono',
              cell: (d) => d.bridge_version ?? '—',
            },
            {
              key: 'serves_mailboxes',
              header: 'Serves',
              className: 'text-xs',
              cell: (d) => `${d.serves_mailboxes} mailbox${d.serves_mailboxes === 1 ? '' : 'es'}`,
            },
          ]}
        />
      )}
    </PageCard>
  );
}
