// W8 — Fleet view of DMARC promotion state across all domains.
//
// Pause/resume/claim-management/run-now actions are approval-gated through
// the panel proxy (W8 endpoints all require admin:rotate).
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { PageCard } from '../../layouts/PageCard.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';
import { dmarcPromotionKeys } from '../../queryKeys.js';
import { formatRelative } from '../../lib/format.js';
import { ErrorText } from '../../components/ErrorText.js';
import { EmptyState } from '../../components/EmptyState.js';

interface DomainRow {
  id: string;
  name: string;
  dmarc_policy: string | null;
  dmarc_promotion_mode: 'auto' | 'manual' | 'paused';
  dmarc_promotion_state:
    | 'none'
    | 'quarantine_ready'
    | 'quarantine'
    | 'reject_ready'
    | 'reject'
    | 'paused';
  dmarc_promotion_last_at: string | null;
  dmarc_record_managed_by_polaris: number;
}

function stateVariant(s: DomainRow['dmarc_promotion_state']) {
  if (s === 'reject') return 'success';
  if (s === 'quarantine' || s === 'reject_ready') return 'secondary';
  if (s === 'paused') return 'destructive';
  return 'outline';
}

function modeVariant(m: DomainRow['dmarc_promotion_mode']) {
  if (m === 'auto') return 'success';
  if (m === 'manual') return 'secondary';
  return 'destructive';
}

function RowActions({ row }: { row: DomainRow }) {
  const [busy, setBusy] = useState(false);
  const pause = useAdminMutation<unknown, undefined>(
    () => ({ path: `/api/admin/dmarc-promotion/${row.id}/pause`, method: 'POST' }),
    { invalidateKeys: [dmarcPromotionKeys.all], successMessage: 'Paused.' },
  );
  const resume = useAdminMutation<unknown, undefined>(
    () => ({ path: `/api/admin/dmarc-promotion/${row.id}/resume`, method: 'POST' }),
    { invalidateKeys: [dmarcPromotionKeys.all], successMessage: 'Resumed.' },
  );
  const claim = useAdminMutation<unknown, undefined>(
    () => ({ path: `/api/admin/dmarc-promotion/${row.id}/claim-management`, method: 'POST' }),
    { invalidateKeys: [dmarcPromotionKeys.all], successMessage: 'Claimed DNS management.' },
  );
  return (
    <div className="flex gap-2">
      {row.dmarc_promotion_mode === 'auto' && (
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            setBusy(true);
            await pause.mutateAsync(undefined);
            setBusy(false);
          }}
          disabled={busy}
        >
          Pause
        </Button>
      )}
      {row.dmarc_promotion_mode !== 'auto' && (
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            setBusy(true);
            await resume.mutateAsync(undefined);
            setBusy(false);
          }}
          disabled={busy}
        >
          Resume
        </Button>
      )}
      {row.dmarc_record_managed_by_polaris === 0 && (
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            setBusy(true);
            await claim.mutateAsync(undefined);
            setBusy(false);
          }}
          disabled={busy}
          title="Opt in to letting Polaris write _dmarc DNS records for this domain"
        >
          Claim DNS
        </Button>
      )}
    </div>
  );
}

export function DmarcPromotionList() {
  const q = useAdminQuery<{ data: DomainRow[] }>(
    dmarcPromotionKeys.list(),
    '/api/admin/dmarc-promotion',
  );
  const runNow = useAdminMutation<{ candidates: number; promoted: number; paused: number }, void>(
    () => ({ path: '/api/admin/dmarc-promotion/run', method: 'POST' }),
    {
      invalidateKeys: [dmarcPromotionKeys.all],
      successMessage: 'Promotion cron triggered.',
    },
  );
  const rows = q.data?.data ?? [];
  return (
    <PageCard
      title="DMARC promotion"
      description="Per-domain auto-promotion state. Cron runs daily; observe-only until you claim DNS management."
      decorative
    >
      <div className="mb-4 flex justify-end">
        <Button
          variant="outline"
          onClick={() => runNow.mutate()}
          disabled={runNow.isPending}
          title="Run the W8 promotion cron immediately"
        >
          {runNow.isPending ? 'Running…' : 'Run promotion cron now'}
        </Button>
      </div>
      {q.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : q.error ? (
        <ErrorText error={q.error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No domains"
          description="Add a domain on the Domains page to see DMARC promotion state."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Domain</TableHead>
              <TableHead>Policy</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Mode</TableHead>
              <TableHead>DNS managed</TableHead>
              <TableHead>Last transition</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-xs">
                  <Link to="/domains/$id" params={{ id: r.id }} className="underline">
                    {r.name}
                  </Link>
                </TableCell>
                <TableCell className="font-mono text-xs">{r.dmarc_policy ?? 'none'}</TableCell>
                <TableCell>
                  <Badge variant={stateVariant(r.dmarc_promotion_state)}>
                    {r.dmarc_promotion_state}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge variant={modeVariant(r.dmarc_promotion_mode)}>
                    {r.dmarc_promotion_mode}
                  </Badge>
                </TableCell>
                <TableCell>
                  {r.dmarc_record_managed_by_polaris === 1 ? (
                    <Badge variant="success">yes</Badge>
                  ) : (
                    <Badge variant="outline">no</Badge>
                  )}
                </TableCell>
                <TableCell title={r.dmarc_promotion_last_at ?? ''}>
                  {r.dmarc_promotion_last_at ? formatRelative(r.dmarc_promotion_last_at) : '—'}
                </TableCell>
                <TableCell>
                  <RowActions row={r} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </PageCard>
  );
}
