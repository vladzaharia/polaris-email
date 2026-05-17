// Webhook DLQ browser — GET /v1/admin/webhook-dlq. Per-row Replay + Drop
// buttons. Drop is gated behind the shared destructive dialog because it
// removes the row irreversibly; the original webhook delivery is gone.
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { PageCard } from '../../layouts/PageCard.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { Badge } from '../../components/ui/badge.js';
import { DestructiveActionDialog } from '../../components/DestructiveActionDialog.js';
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';
import { dlqKeys } from '../../queryKeys.js';
import { formatDate, formatRelative } from '../../lib/format.js';
import { ErrorText } from '../../components/ErrorText.js';
import { EmptyState } from '../../components/EmptyState.js';

interface DlqRow {
  id: string;
  message_id: string | null;
  webhook_sub_id: string;
  attempts: number;
  last_status_code: number | null;
  last_error: string | null;
  dlq_at: string;
}

export function DlqBrowser() {
  const [subFilter, setSubFilter] = useState('');
  const [dropTarget, setDropTarget] = useState<DlqRow | null>(null);
  const q = useAdminQuery<{ data: DlqRow[] }>(dlqKeys.list(), '/api/admin/webhook-dlq');
  const replay = useAdminMutation<unknown, { id: string }>(
    (vars) => ({ path: `/api/admin/webhook-dlq/${vars.id}/replay`, method: 'POST' }),
    { invalidateKeys: [dlqKeys.all], successMessage: 'Replay queued.' },
  );
  const drop = useAdminMutation<unknown, { id: string }>(
    (vars) => ({ path: `/api/admin/webhook-dlq/${vars.id}/drop`, method: 'POST' }),
    { invalidateKeys: [dlqKeys.all], successMessage: 'DLQ entry dropped.' },
  );

  const rows = (q.data?.data ?? []).filter((r) =>
    subFilter ? r.webhook_sub_id.includes(subFilter) : true,
  );

  return (
    <PageCard title="Dead-letter queue" description="Failed webhook deliveries." decorative>
      <div className="mb-4 max-w-sm">
        <Label htmlFor="filter">Webhook sub id contains</Label>
        <Input id="filter" value={subFilter} onChange={(e) => setSubFilter(e.target.value)} />
      </div>
      {q.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : q.error ? (
        <ErrorText error={q.error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="DLQ is empty"
          description="No webhook deliveries have failed enough to be dead-lettered."
        />
      ) : (
        // First column gets `sticky left-0` so the DLQ id stays visible as
        // the row scrolls horizontally on narrow viewports. (Phase 6b.5)
        <div className="overflow-x-auto">
          <Table>
            <caption className="sr-only">
              Failed webhook deliveries with retry counters and per-row Replay or Drop actions.
            </caption>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 z-10 bg-[var(--color-card)]">DLQ id</TableHead>
                <TableHead>Webhook sub</TableHead>
                <TableHead>Attempts</TableHead>
                <TableHead>Last status</TableHead>
                <TableHead>Age</TableHead>
                <TableHead>Message</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="sticky left-0 z-10 bg-[var(--color-card)] font-mono text-xs">
                    {r.id}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.webhook_sub_id}</TableCell>
                  <TableCell>{r.attempts}</TableCell>
                  <TableCell>
                    {r.last_status_code ? (
                      <Badge variant="destructive">{r.last_status_code}</Badge>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className="text-xs" title={formatDate(r.dlq_at)}>
                    {formatRelative(r.dlq_at)}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {r.message_id ? (
                      <Link to="/messages/$id" params={{ id: r.message_id }} className="underline">
                        {r.message_id.slice(0, 10)}…
                      </Link>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => replay.mutate({ id: r.id })}
                        disabled={replay.isPending}
                      >
                        Replay
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => setDropTarget(r)}
                        disabled={drop.isPending}
                      >
                        Drop
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <DestructiveActionDialog
        open={dropTarget != null}
        onOpenChange={(o) => !o && setDropTarget(null)}
        action="Drop DLQ entry"
        name={dropTarget?.id}
        blastRadius={[
          'The original webhook delivery is discarded — there is no later way to replay it',
          'The downstream consumer will never see this event',
          'The associated message row is not affected',
        ]}
        reversible={false}
        confirmLabel="Drop"
        onConfirm={async () => {
          if (!dropTarget) return;
          await drop.mutateAsync({ id: dropTarget.id });
          setDropTarget(null);
        }}
        isPending={drop.isPending}
      />
    </PageCard>
  );
}
