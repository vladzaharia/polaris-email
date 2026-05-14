// Webhook DLQ browser — GET /v1/admin/webhook-dlq. Per-row Replay + Drop
// buttons audited.
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
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';

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
  const q = useAdminQuery<{ data: DlqRow[] }>(['webhook-dlq'], '/api/admin/webhook-dlq');
  const replay = useAdminMutation<unknown, { id: string }>(
    (vars) => ({ path: `/api/admin/webhook-dlq/${vars.id}/replay`, method: 'POST' }),
    { invalidateKeys: [['webhook-dlq']] },
  );
  const drop = useAdminMutation<unknown, { id: string }>(
    (vars) => ({ path: `/api/admin/webhook-dlq/${vars.id}/drop`, method: 'POST' }),
    { invalidateKeys: [['webhook-dlq']] },
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
        <p className="text-sm text-[var(--color-destructive)]">{q.error.message}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">DLQ is empty.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>DLQ id</TableHead>
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
                <TableCell className="font-mono text-xs">{r.id}</TableCell>
                <TableCell className="font-mono text-xs">{r.webhook_sub_id}</TableCell>
                <TableCell>{r.attempts}</TableCell>
                <TableCell>
                  {r.last_status_code ? (
                    <Badge variant="destructive">{r.last_status_code}</Badge>
                  ) : (
                    '—'
                  )}
                </TableCell>
                <TableCell className="text-xs">{r.dlq_at}</TableCell>
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
                      onClick={() => drop.mutate({ id: r.id })}
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
      )}
    </PageCard>
  );
}
