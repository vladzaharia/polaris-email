// Operator detail — identity, credentials (the operator's pk_op_ api_key
// surfaced as a CLI-typed row), key/pubkey rotation, danger zone.
//
// The "root" operator (id `01J0000000000000000000ROOT`, minted by the
// bootstrap path) cannot be disabled via this page — it's the last-resort
// admin key. Rotation is still allowed.
import { useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { KeyRound, RotateCw, ShieldAlert, UserCog } from 'lucide-react';
import { PageCard } from '../../layouts/PageCard.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { ErrorText } from '../../components/ErrorText.js';
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';
import { operatorKeys } from '../../queryKeys.js';
import { formatDate, formatRelative } from '../../lib/format.js';

const ROOT_OPERATOR_ID = '01J0000000000000000000ROOT';

interface OperatorPayload {
  operator: {
    id: string;
    name: string;
    email: string;
    ssh_pubkey: string;
    ssh_pubkey_fp_sha256: string;
    role: 'admin' | 'operator' | 'readonly';
    disabled_at: string | null;
    created_at: string;
    updated_at: string;
    last_seen_at: string | null;
    api_key_id: string | null;
    api_key_prefix: string | null;
    api_key_status: 'primary' | 'secondary' | 'revoked' | null;
    api_key_last_used_at: string | null;
    api_key_created_at: string | null;
  };
}

interface RotateKeyResponse {
  api_key_id: string;
  api_key_prefix: string;
  api_key_secret: string;
  login_token: string;
}

export function OperatorDetail() {
  const { id } = useParams({ from: '/operators/$id' });
  const q = useAdminQuery<OperatorPayload>(operatorKeys.detail(id), `/api/admin/operators/${id}`);
  const [rotatedToken, setRotatedToken] = useState<string | null>(null);

  const rotateKey = useAdminMutation<RotateKeyResponse, undefined>(
    () => ({ path: `/api/admin/operators/${id}/rotate-key`, method: 'POST' }),
    {
      invalidateKeys: [operatorKeys.detail(id), operatorKeys.list()],
      successMessage: 'API key rotated. Copy the new login token now.',
    },
  );

  async function handleRotate(): Promise<void> {
    const r = await rotateKey.mutateAsync(undefined);
    setRotatedToken(r.login_token);
  }

  const disable = useAdminMutation<unknown, undefined>(
    () => ({ path: `/api/admin/operators/${id}`, method: 'DELETE' }),
    {
      invalidateKeys: [operatorKeys.detail(id), operatorKeys.list()],
      successMessage: 'Operator disabled.',
    },
  );

  if (q.isLoading) return <Skeleton className="h-48 w-full" />;
  if (q.error) return <ErrorText error={q.error} />;
  const op = q.data?.operator;
  if (!op) return <p className="text-sm">Operator not found.</p>;

  const isRoot = op.id === ROOT_OPERATOR_ID;

  return (
    <PageCard
      breadcrumbs={[{ label: 'Operators', to: '/operators' }, { label: op.name }]}
      title={
        <span className="flex items-center gap-2">
          <UserCog className="h-5 w-5" /> {op.name}
          {isRoot ? <Badge variant="success">root</Badge> : null}
        </span>
      }
      description={op.email}
      actions={
        <Badge variant={op.disabled_at ? 'destructive' : 'success'}>
          {op.disabled_at ? 'disabled' : 'active'}
        </Badge>
      }
    >
      <div className="space-y-6">
        <section className="rounded-md border border-[var(--color-border)] p-4">
          <h2 className="mb-2 text-base font-semibold">Identity</h2>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-[var(--color-muted-foreground)]">Role</dt>
            <dd>
              <Badge variant={op.role === 'admin' ? 'success' : 'outline'}>{op.role}</Badge>
            </dd>
            <dt className="text-[var(--color-muted-foreground)]">SSH fingerprint</dt>
            <dd className="font-mono text-xs break-all">{op.ssh_pubkey_fp_sha256}</dd>
            <dt className="text-[var(--color-muted-foreground)]">Created</dt>
            <dd className="text-xs">{formatDate(op.created_at)}</dd>
            <dt className="text-[var(--color-muted-foreground)]">Last seen</dt>
            <dd className="text-xs">
              {op.last_seen_at ? formatRelative(op.last_seen_at) : 'never'}
            </dd>
          </dl>
        </section>

        <section className="rounded-md border border-[var(--color-border)] p-4">
          <header className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="flex items-center gap-2 text-base font-semibold">
                <KeyRound className="h-4 w-4" /> Credentials
              </h2>
              <p className="text-xs text-[var(--color-muted-foreground)]">
                CLI / admin API token for this operator. Rotate to replace; the new token is shown
                once.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void handleRotate();
              }}
              disabled={rotateKey.isPending || op.disabled_at !== null}
            >
              <RotateCw className="h-4 w-4" /> Rotate
            </Button>
          </header>
          {op.api_key_id ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[80px]">Type</TableHead>
                    <TableHead>Identity</TableHead>
                    <TableHead className="w-[100px]">Status</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Last used</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow className="text-sm">
                    <TableCell>
                      <Badge variant="outline">cli</Badge>
                    </TableCell>
                    <TableCell>
                      <code className="font-mono text-xs">
                        {op.api_key_prefix}
                        {op.api_key_id}
                      </code>
                    </TableCell>
                    <TableCell>
                      <Badge variant={op.api_key_status === 'primary' ? 'success' : 'outline'}>
                        {op.api_key_status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">
                      {op.api_key_created_at ? formatDate(op.api_key_created_at) : '—'}
                    </TableCell>
                    <TableCell className="text-xs">
                      {op.api_key_last_used_at ? formatRelative(op.api_key_last_used_at) : 'never'}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="text-sm text-[var(--color-muted-foreground)]">
              No primary key. Use Rotate to mint one.
            </p>
          )}
          {rotatedToken ? (
            <div className="mt-3 rounded-md border border-[var(--color-warning)] bg-[var(--color-muted)] p-3">
              <p className="mb-1 text-xs font-semibold">One-time login token — copy now</p>
              <code className="block break-all font-mono text-xs">{rotatedToken}</code>
              <Button
                size="sm"
                variant="outline"
                className="mt-2"
                onClick={() => setRotatedToken(null)}
              >
                Dismiss
              </Button>
            </div>
          ) : null}
        </section>

        {!isRoot && !op.disabled_at ? (
          <section className="rounded-md border border-[var(--color-destructive)] p-4">
            <h2 className="mb-2 flex items-center gap-2 text-base font-semibold">
              <ShieldAlert className="h-4 w-4" /> Danger zone
            </h2>
            <p className="mb-3 text-xs text-[var(--color-muted-foreground)]">
              Disabling an operator revokes their api_key and SSH login. Can be undone via PATCH.
            </p>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => disable.mutate(undefined)}
              disabled={disable.isPending}
            >
              Disable operator
            </Button>
          </section>
        ) : null}
      </div>
    </PageCard>
  );
}
