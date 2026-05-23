// AuditFeedCard — recent operator changes scoped to one domain.
//
// Queries `/v1/admin/domains/:id/audit` (target = domain_id filter) and
// renders a chronological list. Audit rows are heterogeneous, so a list
// reads better than a table — each row shows action + actor + relative
// time + a one-line human summary, and clicking expands the full `meta`
// JSON for triage.
import { useState } from 'react';
import { History } from 'lucide-react';
import { Skeleton } from '../../components/ui/skeleton.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorText } from '../../components/ErrorText.js';
import { useAdminQuery } from '../../hooks/useAdminApi.js';
import { domainKeys } from '../../queryKeys.js';
import { formatRelative } from '../../lib/format.js';

interface AuditRow {
  id: number;
  actor: string;
  action: string;
  target: string;
  at: number;
  prev_hash: string;
  row_hash: string;
  meta: string | null;
}

function formatActor(actor: string): string {
  if (actor === 'system') return 'system';
  if (actor.startsWith('operator:')) return `operator ${actor.slice('operator:'.length)}`;
  if (actor.startsWith('key:')) return `key ${actor.slice('key:'.length)}`;
  return actor;
}

// Action → human one-liner. Switch by prefix so unknown future actions fall
// back to the raw string instead of crashing.
function summarizeAction(action: string, meta: Record<string, unknown> | null): string {
  switch (action) {
    case 'domain.create':
      return `Created domain${meta?.name ? ` ${String(meta.name)}` : ''}`;
    case 'domain.update':
      return 'Updated domain settings';
    case 'domain.delete':
      return 'Deleted domain';
    case 'domain.verify':
      return 'Triggered verification';
    case 'domain.dkim.rotate':
      return `Rotated DKIM${meta?.selector ? ` to selector ${String(meta.selector)}` : ''}`;
    case 'domain.inbound.enable':
      return 'Enabled inbound';
    case 'domain.inbound.disable':
      return 'Disabled inbound';
    case 'domain.outbound.enable':
      return 'Enabled outbound';
    case 'domain.outbound.disable':
      return 'Disabled outbound';
    case 'domain.mta_sts.update':
    case 'domain.mta_sts.enable':
      return 'Updated MTA-STS policy';
    case 'domain.mta_sts.disable':
      return 'Disabled MTA-STS';
    case 'domain.tls_rpt.enable':
      return 'Enabled TLS-RPT';
    case 'domain.tls_rpt.disable':
      return 'Disabled TLS-RPT';
    default:
      return action;
  }
}

function parseMeta(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function AuditRowItem({ row }: { row: AuditRow }) {
  const [expanded, setExpanded] = useState(false);
  const meta = parseMeta(row.meta);
  const hasMeta = meta !== null && Object.keys(meta).length > 0;
  return (
    <li className="rounded-md border border-[var(--color-border)] p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="font-mono text-[10px]">
          {row.action}
        </Badge>
        <span className="font-medium">{summarizeAction(row.action, meta)}</span>
        <span
          className="ml-auto text-xs text-[var(--color-muted-foreground)]"
          title={new Date(row.at).toISOString()}
        >
          {formatRelative(row.at)}
        </span>
      </div>
      <div className="mt-1 text-xs text-[var(--color-muted-foreground)]">
        by <span className="font-mono">{formatActor(row.actor)}</span>
      </div>
      {hasMeta ? (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-xs underline hover:text-[var(--color-foreground)]"
          >
            {expanded ? 'Hide details' : 'Show details'}
          </button>
          {expanded ? (
            <pre className="mt-2 overflow-x-auto rounded-md bg-[var(--color-muted)] p-2 font-mono text-[11px] text-[var(--color-foreground)]">
              {JSON.stringify(meta, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

const PAGE_LIMIT = 25;

export function AuditFeedCard({ domainId }: { domainId: string }) {
  const [beforeId, setBeforeId] = useState<number | null>(null);
  const path = beforeId
    ? `/api/admin/domains/${domainId}/audit?limit=${PAGE_LIMIT}&before_id=${beforeId}`
    : `/api/admin/domains/${domainId}/audit?limit=${PAGE_LIMIT}`;
  const q = useAdminQuery<{ data: AuditRow[] }>(
    [...domainKeys.audit(domainId), beforeId ?? 0] as const,
    path,
  );
  const rows = q.data?.data ?? [];
  const oldestId = rows.length > 0 ? rows[rows.length - 1]!.id : null;
  const hitLimit = rows.length === PAGE_LIMIT;
  return (
    <section className="rounded-md border border-[var(--color-border)] p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <span className="text-[var(--color-muted-foreground)]" aria-hidden>
            <History className="h-4 w-4" />
          </span>
          Recent activity
        </h2>
      </div>
      {q.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : q.error ? (
        <ErrorText error={q.error} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<History className="h-5 w-5" />}
          title="No recorded changes yet for this domain"
          description="Operator actions on this domain (verify, rotate DKIM, enable/disable, MTA-STS changes) will appear here."
        />
      ) : (
        <>
          <ul className="space-y-2">
            {rows.map((r) => (
              <AuditRowItem key={r.id} row={r} />
            ))}
          </ul>
          {hitLimit && oldestId ? (
            <div className="mt-3 flex justify-center">
              <Button size="sm" variant="outline" onClick={() => setBeforeId(oldestId)}>
                Load older
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
