// Account page — surfaces /api/me + recent audit log entries scoped to this
// user (filtered client-side from the chain endpoint).
import { PageCard } from '../../layouts/PageCard.js';
import { Badge } from '../../components/ui/badge.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { EmptyState } from '../../components/EmptyState.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { useAdminQuery } from '../../hooks/useAdminApi.js';
import { auditKeys } from '../../queryKeys.js';
import { formatDate, formatRelative } from '../../lib/format.js';

interface Me {
  authenticated: boolean;
  subject?: string;
  email?: string;
  admin?: boolean;
}

interface AuditEntry {
  id: number;
  actor: string;
  action: string;
  target: string;
  at: number;
}

export function Account() {
  const me = useAdminQuery<Me>(['me'] as const, '/api/me');
  // Cap the chain pull at 200 entries so the panel doesn't fetch an
  // unbounded payload. Filtering happens client-side because services/api
  // doesn't accept `?actor=` today; once it does, request it here and
  // remove the local filter.
  const audit = useAdminQuery<{ data: AuditEntry[] }>(
    auditKeys.chain(),
    '/api/admin/audit/chain?limit=200',
  );
  const myEntries = (audit.data?.data ?? []).filter((e) =>
    me.data?.email ? e.actor.includes(me.data.email) : false,
  );
  return (
    <PageCard title="Account" description="OIDC identity." decorative>
      {me.isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : !me.data?.authenticated ? (
        <p className="text-sm text-[var(--color-destructive)]">Not signed in.</p>
      ) : (
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt className="text-[var(--color-muted-foreground)]">Subject</dt>
          <dd className="font-mono">{me.data.subject}</dd>
          <dt className="text-[var(--color-muted-foreground)]">Email</dt>
          <dd>{me.data.email}</dd>
          <dt className="text-[var(--color-muted-foreground)]">Admin</dt>
          <dd>
            {me.data.admin ? (
              <Badge variant="success">yes</Badge>
            ) : (
              <Badge variant="outline">no</Badge>
            )}
          </dd>
        </dl>
      )}

      <section className="mt-6">
        <h2 className="mb-2 text-xl font-medium">Recent audit entries</h2>
        {audit.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : myEntries.length === 0 ? (
          <EmptyState title="No entries for this account" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Target</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {myEntries.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="text-xs" title={formatDate(e.at)}>
                    {formatRelative(e.at)}
                  </TableCell>
                  <TableCell>{e.action}</TableCell>
                  <TableCell className="font-mono text-xs">{e.target}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </PageCard>
  );
}
