// Domains list — GET /v1/admin/domains. Inbound/outbound toggles and DKIM
// rotate live on the detail page.
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
import { Badge } from '../../components/ui/badge.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { useAdminQuery } from '../../hooks/useAdminApi.js';

interface DomainRow {
  id: string;
  name: string;
  status: 'pending' | 'verified' | 'failed' | 'disabled' | string;
  dkim_selector: string | null;
  inbound_enabled?: number;
  outbound_enabled?: number;
}

function statusBadge(s: string) {
  if (s === 'verified') return <Badge variant="success">verified</Badge>;
  if (s === 'pending') return <Badge variant="secondary">pending</Badge>;
  if (s === 'failed') return <Badge variant="destructive">failed</Badge>;
  return <Badge variant="outline">{s}</Badge>;
}

export function DomainsList() {
  const q = useAdminQuery<{ data: DomainRow[] }>(['domains'], '/api/admin/domains');
  const rows = q.data?.data ?? [];
  return (
    <PageCard title="Domains" description="Sender/recipient domain registry." decorative>
      {q.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : q.error ? (
        <p className="text-sm text-[var(--color-destructive)]">{q.error.message}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">No domains registered.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Domain</TableHead>
              <TableHead>Inbound</TableHead>
              <TableHead>Outbound</TableHead>
              <TableHead>DKIM</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  <Link to="/domains/$id" params={{ id: r.id }} className="underline">
                    {r.name}
                  </Link>
                </TableCell>
                <TableCell>{r.inbound_enabled ? 'on' : 'off'}</TableCell>
                <TableCell>{r.outbound_enabled ? 'on' : 'off'}</TableCell>
                <TableCell className="font-mono text-xs">{r.dkim_selector ?? '—'}</TableCell>
                <TableCell>{statusBadge(r.status)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </PageCard>
  );
}
