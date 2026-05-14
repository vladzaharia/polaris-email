// Credentials list — union of api_keys + smtp_credentials via
// GET /v1/admin/credentials?mailbox=<id>.
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

interface MailboxRow {
  id: string;
  name: string;
}

interface CredRow {
  kind: 'api_key' | 'smtp';
  id: string;
  status: string;
  created_at: string;
  username?: string;
}

export function CredentialsList() {
  const mailboxes = useAdminQuery<{ data: MailboxRow[] }>(['mailboxes'], '/api/admin/mailboxes');
  const [mailboxId, setMailboxId] = useState<string>('');
  const creds = useAdminQuery<{ data: CredRow[] }>(
    ['credentials', mailboxId],
    `/api/admin/credentials?mailbox=${mailboxId}`,
    { enabled: !!mailboxId },
  );
  return (
    <PageCard
      title="Credentials"
      description="API keys + SMTP credentials, scoped per mailbox."
      decorative
    >
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
          Pick a mailbox above to list credentials.
        </p>
      ) : creds.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : creds.error ? (
        <p className="text-sm text-[var(--color-destructive)]">{creds.error.message}</p>
      ) : (creds.data?.data ?? []).length === 0 ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">No credentials.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Username</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(creds.data?.data ?? []).map((c) => (
              <TableRow key={`${c.kind}:${c.id}`}>
                <TableCell>
                  <Link to="/credentials/$id" params={{ id: c.id }} className="underline">
                    {c.id}
                  </Link>
                </TableCell>
                <TableCell>{c.kind}</TableCell>
                <TableCell className="font-mono text-xs">{c.username ?? '—'}</TableCell>
                <TableCell>
                  {c.status === 'active' || c.status === 'primary' ? (
                    <Badge variant="success">{c.status}</Badge>
                  ) : (
                    <Badge variant="secondary">{c.status}</Badge>
                  )}
                </TableCell>
                <TableCell className="text-xs">{c.created_at}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </PageCard>
  );
}
