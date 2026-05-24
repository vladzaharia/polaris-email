// Operators list — table over GET /v1/admin/operators.
//
// Surfaces every human (and synthetic service-key) operator with their
// role, fingerprint, last-seen, and current primary api_key status.
// Mint via CLI for now (`polaris-mail operator add`); the panel form is
// a follow-up because the response includes a one-time login token that
// needs careful read-once handling.
import { Plus, UserCog } from 'lucide-react';
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
import { Button } from '../../components/ui/button.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorText } from '../../components/ErrorText.js';
import { useAdminQuery } from '../../hooks/useAdminApi.js';
import { operatorKeys } from '../../queryKeys.js';
import { formatRelative } from '../../lib/format.js';

interface OperatorRow {
  id: string;
  name: string;
  email: string;
  ssh_pubkey_fp_sha256: string;
  role: 'admin' | 'operator' | 'readonly';
  disabled_at: string | null;
  created_at: string;
  last_seen_at: string | null;
  api_key_id: string | null;
  api_key_prefix: string | null;
  api_key_status: 'primary' | 'secondary' | 'revoked' | null;
}

export function OperatorsList() {
  const q = useAdminQuery<{ data: OperatorRow[] }>(operatorKeys.list(), '/api/admin/operators');
  const rows = q.data?.data ?? [];
  return (
    <PageCard
      title={
        <span className="flex items-center gap-2">
          <UserCog className="h-5 w-5" /> Operators
        </span>
      }
      description="Humans (and service principals) who hold a polaris CLI / admin API token. Each operator owns one primary api_key; rotate via the detail page."
      actions={
        <Button
          size="sm"
          disabled
          title="Use `polaris-mail operator add` until the panel form ships"
        >
          <Plus className="h-4 w-4" /> Add operator
        </Button>
      }
    >
      {q.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : q.error ? (
        <ErrorText error={q.error} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<UserCog className="h-5 w-5" />}
          title="No operators yet"
          description="The bootstrap-admin operator should always be present. If you see this, run polaris-mail setup infra preflight."
        />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Fingerprint</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id} className="text-sm">
                  <TableCell>
                    <a href={`/operators/${r.id}`} className="font-medium underline">
                      {r.name}
                    </a>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.email}</TableCell>
                  <TableCell>
                    <Badge variant={r.role === 'admin' ? 'success' : 'outline'}>{r.role}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-[11px]">
                    {r.ssh_pubkey_fp_sha256.slice(0, 24)}…
                  </TableCell>
                  <TableCell className="text-xs text-[var(--color-muted-foreground)]">
                    {r.last_seen_at ? formatRelative(r.last_seen_at) : 'never'}
                  </TableCell>
                  <TableCell>
                    <Badge variant={r.disabled_at ? 'destructive' : 'success'}>
                      {r.disabled_at ? 'disabled' : 'active'}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </PageCard>
  );
}
