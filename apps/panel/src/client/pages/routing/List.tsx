// Routing list — per-mailbox view of mailbox_receivers.
//
// The receiver rows aren't surfaced via a single admin endpoint; we fetch
// mailboxes, then for the selected one read its receivers from the mailbox
// detail payload. Cross-mailbox aggregation would require a new endpoint; we
// keep the per-mailbox UX which is closer to operator intent anyway.
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
import { Skeleton } from '../../components/ui/skeleton.js';
import { Label } from '../../components/ui/label.js';
import { useAdminQuery } from '../../hooks/useAdminApi.js';

interface MailboxRow {
  id: string;
  name: string;
}
interface ReceiverRow {
  id: string;
  domain_id: string;
  priority: number;
  address_pattern: string;
  action: string;
  enabled: number;
  webhook_sub_id?: string | null;
  forward_to?: string | null;
}

export function RoutingList() {
  const mailboxes = useAdminQuery<{ data: MailboxRow[] }>(['mailboxes'], '/api/admin/mailboxes');
  const [mailboxId, setMailboxId] = useState('');
  const detail = useAdminQuery<{ receivers: ReceiverRow[] }>(
    ['mailbox', mailboxId],
    `/api/admin/mailboxes/${mailboxId}`,
    { enabled: !!mailboxId },
  );
  return (
    <PageCard title="Routing rules" description="Per-mailbox receiver chains." decorative>
      <div className="mb-4 max-w-sm">
        <Label>Mailbox</Label>
        <select
          value={mailboxId}
          onChange={(e) => setMailboxId(e.target.value)}
          className="mt-1 block w-full rounded-md border bg-transparent px-3 py-2 text-sm"
        >
          <option value="">Pick a mailbox</option>
          {(mailboxes.data?.data ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </div>
      {!mailboxId ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Pick a mailbox to view its receiver chain.
        </p>
      ) : detail.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : (detail.data?.receivers ?? []).length === 0 ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">No receivers configured.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Priority</TableHead>
              <TableHead>Pattern</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Enabled</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(detail.data?.receivers ?? []).map((r) => (
              <TableRow key={r.id}>
                <TableCell>{r.priority}</TableCell>
                <TableCell className="font-mono text-xs">
                  <Link to="/routing/$id" params={{ id: r.id }} className="underline">
                    {r.address_pattern}
                  </Link>
                </TableCell>
                <TableCell>{r.action}</TableCell>
                <TableCell className="font-mono text-xs">
                  {r.webhook_sub_id ?? r.forward_to ?? '—'}
                </TableCell>
                <TableCell>{r.enabled ? 'yes' : 'no'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </PageCard>
  );
}
