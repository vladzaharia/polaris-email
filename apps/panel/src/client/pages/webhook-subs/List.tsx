// Webhook subs list — mailbox-scoped via GET /v1/admin/webhook-subs.
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
import { Badge } from '../../components/ui/badge.js';
import { Label } from '../../components/ui/label.js';
import { useAdminQuery } from '../../hooks/useAdminApi.js';
import { mailboxKeys, webhookKeys } from '../../queryKeys.js';

interface MailboxRow {
  id: string;
  name: string;
}
interface SubRow {
  id: string;
  mailbox_id: string;
  url: string;
  kind: string;
  events: string;
  paused_at: string | null;
  created_at: string;
}

export function WebhookSubsList() {
  const [mailboxId, setMailboxId] = useState('');
  const mailboxes = useAdminQuery<{ data: MailboxRow[] }>(
    mailboxKeys.list(),
    '/api/admin/mailboxes',
  );
  const path = mailboxId
    ? `/api/admin/webhook-subs?mailbox_id=${mailboxId}`
    : '/api/admin/webhook-subs';
  const q = useAdminQuery<{ data: SubRow[] }>(webhookKeys.list(mailboxId || undefined), path);
  return (
    <PageCard
      title="Webhook subscriptions"
      description="External + tailnet webhook targets."
      decorative
    >
      <div className="mb-4 max-w-sm">
        <Label>Filter by mailbox</Label>
        <select
          value={mailboxId}
          onChange={(e) => setMailboxId(e.target.value)}
          className="mt-1 block w-full rounded-md border bg-transparent px-3 py-2 text-sm"
        >
          <option value="">All mailboxes</option>
          {(mailboxes.data?.data ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </div>
      {q.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : q.error ? (
        <p className="text-sm text-[var(--color-destructive)]">{q.error.message}</p>
      ) : (q.data?.data ?? []).length === 0 ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">No webhook subscriptions.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Target URL</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Events</TableHead>
              <TableHead>Mailbox</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(q.data?.data ?? []).map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-mono text-xs">
                  <Link to="/webhook-subs/$id" params={{ id: s.id }} className="underline">
                    {s.url}
                  </Link>
                </TableCell>
                <TableCell>{s.kind}</TableCell>
                <TableCell className="font-mono text-xs">{s.events}</TableCell>
                <TableCell className="font-mono text-xs">{s.mailbox_id}</TableCell>
                <TableCell>
                  {s.paused_at ? (
                    <Badge variant="secondary">paused</Badge>
                  ) : (
                    <Badge variant="success">active</Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </PageCard>
  );
}
