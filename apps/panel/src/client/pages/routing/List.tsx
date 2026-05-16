// Routing list — per-mailbox view of mailbox_receivers.
//
// The receiver rows aren't surfaced via a single admin endpoint; we fetch
// mailboxes, then for the selected one read its receivers from the mailbox
// detail payload. Cross-mailbox aggregation would require a new endpoint; we
// keep the per-mailbox UX which is closer to operator intent anyway.
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { PageCard } from '../../layouts/PageCard.js';
import { PaginatedTable } from '../../components/PaginatedTable.js';
import { Label } from '../../components/ui/label.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { useAdminQuery } from '../../hooks/useAdminApi.js';
import { mailboxKeys } from '../../queryKeys.js';

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
  const mailboxes = useAdminQuery<{ data: MailboxRow[] }>(
    mailboxKeys.list(),
    '/api/admin/mailboxes',
  );
  const [mailboxId, setMailboxId] = useState('');
  const detail = useAdminQuery<{ receivers: ReceiverRow[] }>(
    mailboxKeys.detail(mailboxId),
    `/api/admin/mailboxes/${mailboxId}`,
    { enabled: !!mailboxId },
  );
  return (
    <PageCard title="Routing rules" description="Per-mailbox receiver chains." decorative>
      <div className="mb-4 max-w-sm">
        <Label>Mailbox</Label>
        <Select value={mailboxId || undefined} onValueChange={setMailboxId}>
          <SelectTrigger className="mt-1">
            <SelectValue placeholder="Pick a mailbox" />
          </SelectTrigger>
          <SelectContent>
            {(mailboxes.data?.data ?? []).map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {!mailboxId ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Pick a mailbox to view its receiver chain.
        </p>
      ) : (
        <PaginatedTable<ReceiverRow>
          caption="Receiver chain for the selected mailbox."
          loading={detail.isLoading}
          rows={detail.data?.receivers ?? []}
          empty="No receivers configured."
          rowKey={(r) => r.id}
          columns={[
            { key: 'priority', header: 'Priority', cell: (r) => r.priority },
            {
              key: 'address_pattern',
              header: 'Pattern',
              className: 'font-mono text-xs',
              cell: (r) => (
                <Link to="/mailboxes/$id" params={{ id: mailboxId }} className="underline">
                  {r.address_pattern}
                </Link>
              ),
            },
            { key: 'action', header: 'Action', cell: (r) => r.action },
            {
              key: 'target',
              header: 'Target',
              className: 'font-mono text-xs',
              cell: (r) => r.webhook_sub_id ?? r.forward_to ?? '—',
            },
            { key: 'enabled', header: 'Enabled', cell: (r) => (r.enabled ? 'yes' : 'no') },
          ]}
        />
      )}
    </PageCard>
  );
}
